import winston from "winston";
import { Camp, CampClass, CampSession, EntryCap, Registration } from "@cyc-seattle/clubspot-sdk";
import { PersonRow } from "@cyc-seattle/crm";
import {
  ClassRow,
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  EntryCapRow,
  ParticipantRow,
  PromotedFieldRow,
  RegistrationBillingRow,
  RegistrationRow,
  SessionClassRow,
  SessionRow,
} from "@cyc-seattle/clubspot";
import {
  DirectusClient,
  SyncQueue,
  SyncRunRow,
  SyncTaskHandler,
  SyncTaskRow,
  runQueue,
  targetFromKey,
  TaskOrphaned,
} from "@cyc-seattle/directus";
import { campBackoff, nextSyncState } from "./backoff.js";
import { PersonSync } from "./person-sync.js";
import { planPromotedFields } from "./promoted-fields.js";
import {
  CollectionPlan,
  planCamps,
  planClasses,
  planEntryCaps,
  planSessionClasses,
  planSessions,
  SessionClassPlan,
} from "./schedule.js";
import {
  firstParticipant,
  planCustomFieldDefinitions,
  planCustomFieldResponses,
  planRegistrationBilling,
  planRegistrationEntries,
  planRegistrations,
  RegistrationBillingPlan,
} from "./registrations.js";
import { CampWithClubspot, RegistrationEntryWithClubspot } from "./schema.js";

/** No prior successful sync: the registration window starts from the beginning of Clubspot history. */
export const EPOCH = new Date(0);

/**
 * Everything the schedule and registration passes need for one camp. `camp` carries
 * `customFieldsArray` (unlike the bare camp `runSync` uses for the backoff check and logging),
 * since `planCustomFieldDefinitions` reads it.
 */
export interface CampData {
  camp: Camp;
  classes: CampClass[];
  sessions: CampSession[];
  entryCaps: EntryCap[];
  registrations: Registration[];
}

/**
 * The Parse side of the sync - camp discovery and the queries that build a camp's data. Kept
 * behind an interface so the orchestration below can be tested with fixtures instead of a live
 * Clubspot query.
 */
export interface SyncGateway {
  discoverCamps(clubId: string): Promise<Camp[]>;
  getCamp(campId: string): Promise<Camp>;
  fetchCampData(camp: Camp, watermark: Date, until: Date): Promise<CampData>;
}

/**
 * TypeScript accepts a function with fewer parameters than the type it's assigned to - that's how
 * `main.ts`'s `fetchCampData(camp)` once typechecked as a `SyncGateway` while silently dropping the
 * watermark and until bounds. `ExactParams` resolves to `never` unless `Fn`'s parameter tuple
 * matches `Expected`'s exactly, so trimming a parameter is a type error again.
 */
type ExactParams<Fn extends (...args: any[]) => any, Expected extends (...args: any[]) => any> =
  Parameters<Fn> extends Parameters<Expected> ? (Parameters<Expected> extends Parameters<Fn> ? Fn : never) : never;

/** Wraps a `fetchCampData` implementation so an arity mismatch against `SyncGateway` fails to compile. */
export function fetchCampDataGateway<Fn extends SyncGateway["fetchCampData"]>(
  fn: ExactParams<Fn, SyncGateway["fetchCampData"]>,
): SyncGateway["fetchCampData"] {
  return fn as SyncGateway["fetchCampData"];
}

// All the collections the schedule and registration passes reconcile against. `people`, `contacts`,
// and `medical_profiles` aren't here: PersonSync reads those with its own bounded, filtered queries
// instead of a full table scan. The promotion pass below reads `people` too, but only its `id` and
// `school` columns - narrower than a full-table read, not wider.
interface SharedTables {
  camps: CampWithClubspot[];
  classes: ClassRow[];
  sessions: SessionRow[];
  sessionClasses: SessionClassRow[];
  entryCaps: EntryCapRow[];
  customFieldDefinitions: CustomFieldDefinitionRow[];
  registrations: RegistrationRow[];
  registrationEntries: RegistrationEntryWithClubspot[];
  registrationBilling: RegistrationBillingRow[];
  customFieldResponses: CustomFieldResponseRow[];
}

/** Narrows every `readSharedTables` collection but `camps` to the one camp for this Clubspot camp. */
interface CampScope {
  clubspotCampId: string;
}

// Directus 403s a dot-notation relational filter (`filter[registration_id.camp_id][_eq]`) on
// these five hop collections - it requires read permission on the traversed field itself, which
// this token doesn't have, independent of what's in `fields` (see #135 follow-up). Chunked `_in` is
// the fallback: a UUID plus its comma separator is ~37 characters, so 40 ids/batch keeps a request's
// id list under 1,480 characters - well under a conservative 2,000-character URL budget once the
// base URL, path, and other query params are added.
const ID_BATCH_SIZE = 40;

/**
 * Reads rows whose `field` matches one of `ids`, batching the `_in` list so no single request's URL
 * grows unbounded with the camp's size - a camp with no classes or registrations yet has
 * nothing for session_classes, entry_caps, or the registration-scoped tables to reference.
 */
async function readByIds<Row>(
  directus: DirectusClient,
  collection: string,
  field: string,
  ids: readonly string[],
): Promise<Row[]> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    batches.push(ids.slice(i, i + ID_BATCH_SIZE));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      directus.readItems<Row>(collection, { filter: { [field]: { _in: batch.join(",") } }, limit: -1 }),
    ),
  );
  return results.flat();
}

/**
 * Reads every table the schedule and registration passes reconcile against, scoped to one camp
 * so a camp sync's read no longer grows with the club's whole history (#135) - fetching each
 * collection's state for just this camp and diffing it in avoids a Directus round trip per pass.
 * `classes`, `sessions`, `custom_field_definitions`, and `registrations` carry `camp_id`
 * directly; `session_classes` and `entry_caps` are reached through their classes'
 * (`entry_caps.session_id` can be null, but `class_id` never is); `registration_entries`,
 * `registration_billing`, and `custom_field_responses` are reached through their registrations.
 * `camps` itself is the one exception - its own id is the Clubspot camp id, so it's just the
 * single row for `scope.clubspotCampId`, or none for a camp synced for the first time, in
 * which case every other table is empty too: nothing can reference a camp that doesn't exist
 * in the CRM yet.
 */
async function readSharedTables(directus: DirectusClient, scope: CampScope): Promise<SharedTables> {
  const camps = await directus.readItems<CampWithClubspot>("camps", {
    filter: { id: { _eq: scope.clubspotCampId } },
    limit: -1,
  });
  const campCrmId = camps[0]?.id;
  if (!campCrmId) {
    return {
      camps,
      classes: [],
      sessions: [],
      sessionClasses: [],
      entryCaps: [],
      customFieldDefinitions: [],
      registrations: [],
      registrationEntries: [],
      registrationBilling: [],
      customFieldResponses: [],
    };
  }

  const [classes, sessions, customFieldDefinitions, registrations] = await Promise.all([
    directus.readItems<ClassRow>("classes", { filter: { camp_id: { _eq: campCrmId } }, limit: -1 }),
    directus.readItems<SessionRow>("sessions", { filter: { camp_id: { _eq: campCrmId } }, limit: -1 }),
    directus.readItems<CustomFieldDefinitionRow>("custom_field_definitions", {
      filter: { camp_id: { _eq: campCrmId } },
      limit: -1,
    }),
    directus.readItems<RegistrationRow>("registrations", {
      filter: { camp_id: { _eq: campCrmId } },
      limit: -1,
    }),
  ]);

  const classIds = classes.map((row) => row.id);
  const registrationIds = registrations.map((row) => row.id);

  const [sessionClasses, entryCaps, registrationEntries, registrationBilling, customFieldResponses] = await Promise.all(
    [
      readByIds<SessionClassRow>(directus, "session_classes", "class_id", classIds),
      readByIds<EntryCapRow>(directus, "entry_caps", "class_id", classIds),
      readByIds<RegistrationEntryWithClubspot>(directus, "registration_entries", "registration_id", registrationIds),
      readByIds<RegistrationBillingRow>(directus, "registration_billing", "registration_id", registrationIds),
      readByIds<CustomFieldResponseRow>(directus, "custom_field_responses", "registration_id", registrationIds),
    ],
  );

  return {
    camps,
    classes,
    sessions,
    sessionClasses,
    entryCaps,
    customFieldDefinitions,
    registrations,
    registrationEntries,
    registrationBilling,
    customFieldResponses,
  };
}

interface ApplyResult<Row> {
  rows: Row[];
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Writes a plan and folds the result back into `existing`, so the next plan for the same camp
 * sees it without a re-read. Every row's `id` is set by the plan itself (the Clubspot objectId, or
 * a joined key), so a dry run's echoed-back input already carries it - unlike an auto-generated
 * uuid, there's no placeholder to fabricate for a later stage's FK to point at.
 */
async function applyPlan<Row extends { id: string }>(
  directus: DirectusClient,
  collection: string,
  plan: CollectionPlan<Row>,
  existing: Row[],
): Promise<ApplyResult<Row>> {
  const createdRows = plan.toCreate.length > 0 ? await directus.createItems<Row>(collection, plan.toCreate) : [];

  for (const update of plan.toUpdate) {
    await directus.updateItem<Row>(collection, update.id, update.patch);
  }

  const patchById = new Map(plan.toUpdate.map((update) => [update.id, update.patch]));
  const rows = existing.map((row) => (patchById.has(row.id) ? { ...row, ...patchById.get(row.id) } : row));

  return {
    rows: [...rows, ...createdRows],
    created: createdRows.length,
    updated: plan.toUpdate.length,
    skipped: plan.skipped ?? 0,
  };
}

interface ApplySessionClassResult {
  rows: SessionClassRow[];
  created: number;
  removed: number;
}

/** `session_classes` has no status field to cancel, so a row Clubspot no longer offers is deleted outright. */
async function applySessionClassPlan(
  directus: DirectusClient,
  plan: SessionClassPlan,
  existing: SessionClassRow[],
): Promise<ApplySessionClassResult> {
  const createdRows =
    plan.toCreate.length > 0 ? await directus.createItems<SessionClassRow>("session_classes", plan.toCreate) : [];

  for (const row of plan.toRemove) {
    await directus.deleteItem("session_classes", row.id);
  }

  const removedIds = new Set(plan.toRemove.map((row) => row.id));
  const rows = existing.filter((row) => !removedIds.has(row.id));

  return { rows: [...rows, ...createdRows], created: createdRows.length, removed: plan.toRemove.length };
}

interface ApplyRegistrationBillingResult {
  rows: RegistrationBillingRow[];
  created: number;
  updated: number;
}

/** Deletes a replaced billing row before creating its successor - see `planRegistrationBilling`. */
async function applyRegistrationBillingPlan(
  directus: DirectusClient,
  plan: RegistrationBillingPlan,
  existing: RegistrationBillingRow[],
): Promise<ApplyRegistrationBillingResult> {
  for (const id of plan.toDelete) {
    await directus.deleteItem("registration_billing", id);
  }

  const createdRows =
    plan.toCreate.length > 0
      ? await directus.createItems<RegistrationBillingRow>("registration_billing", plan.toCreate)
      : [];

  for (const update of plan.toUpdate) {
    await directus.updateItem<RegistrationBillingRow>("registration_billing", update.id, update.patch);
  }

  const patchById = new Map(plan.toUpdate.map((update) => [update.id, update.patch]));
  const deletedIds = new Set(plan.toDelete);
  const rows = existing
    .filter((row) => !deletedIds.has(row.id))
    .map((row) => (patchById.has(row.id) ? { ...row, ...patchById.get(row.id) } : row));

  return { rows: [...rows, ...createdRows], created: createdRows.length, updated: plan.toUpdate.length };
}

export interface CampSyncCounts {
  created: number;
  updated: number;
  skipped: number;
  participantsCreated: number;
}

interface ScheduleSyncResult {
  counts: Omit<CampSyncCounts, "participantsCreated">;
}

/**
 * `camps`, `sessions`, `classes`, `session_classes`, `entry_caps` - reconciled in full every
 * time, not watermark-filtered, following `SCHEDULE_CREATE_ORDER`.
 */
async function syncSchedule(
  data: CampData,
  tables: SharedTables,
  directus: DirectusClient,
): Promise<ScheduleSyncResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const campPlan = planCamps([data.camp], tables.camps);
  const campResult = await applyPlan(directus, "camps", campPlan, tables.camps);
  tables.camps = campResult.rows;
  created += campResult.created;
  updated += campResult.updated;

  const sessionPlan = planSessions(data.sessions, tables.sessions);
  const sessionResult = await applyPlan(directus, "sessions", sessionPlan, tables.sessions);
  tables.sessions = sessionResult.rows;
  created += sessionResult.created;
  updated += sessionResult.updated;

  const classPlan = planClasses(data.classes, tables.classes);
  const classResult = await applyPlan(directus, "classes", classPlan, tables.classes);
  tables.classes = classResult.rows;
  created += classResult.created;
  updated += classResult.updated;

  const campClassIds = data.classes.map((campClass) => campClass.id);
  const sessionClassPlan = planSessionClasses(data.sessions, campClassIds, tables.sessionClasses);
  const sessionClassResult = await applySessionClassPlan(directus, sessionClassPlan, tables.sessionClasses);
  tables.sessionClasses = sessionClassResult.rows;
  created += sessionClassResult.created;
  updated += sessionClassResult.removed; // A removal is a modification to the schedule, same bucket as an update.

  const knownSessionIds = new Set(tables.sessions.map((row) => row.id));
  const entryCapPlan = planEntryCaps(data.entryCaps, knownSessionIds, tables.entryCaps);
  const entryCapResult = await applyPlan(directus, "entry_caps", entryCapPlan, tables.entryCaps);
  tables.entryCaps = entryCapResult.rows;
  created += entryCapResult.created;
  updated += entryCapResult.updated;
  skipped += entryCapResult.skipped;

  return { counts: { created, updated, skipped } };
}

/**
 * `custom_field_definitions`, `people`/`contacts`/`medical_profiles`/`participants` (via
 * `PersonSync` and the participant lookup below), `registrations`, `registration_entries`,
 * `registration_billing`, `custom_field_responses` - filtered to what's in `data.registrations`,
 * following `REGISTRATION_CREATE_ORDER`.
 */
async function syncRegistrations(
  data: CampData,
  tables: SharedTables,
  directus: DirectusClient,
  personSync: PersonSync,
  runId: string | undefined,
): Promise<CampSyncCounts> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const definitionPlan = planCustomFieldDefinitions([data.camp], tables.customFieldDefinitions);
  const definitionResult = await applyPlan(
    directus,
    "custom_field_definitions",
    definitionPlan,
    tables.customFieldDefinitions,
  );
  tables.customFieldDefinitions = definitionResult.rows;
  created += definitionResult.created;
  updated += definitionResult.updated;
  const knownDefinitionIds = new Set(tables.customFieldDefinitions.map((row) => row.id));

  // `participants` survives every rebuild and holds each registration's pinned person link. A
  // registration whose participant is already on file reuses that link (PersonSync.syncParticipant's
  // existingPersonId path) rather than matching again; only a genuinely new participant runs the
  // matcher and gets a fresh `participants` row.
  const participantIds = data.registrations.flatMap((registration) => {
    const participant = firstParticipant(registration);
    return participant ? [participant.id] : [];
  });
  const existingParticipants = await readByIds<ParticipantRow>(directus, "participants", "id", participantIds);
  const existingParticipantById = new Map(existingParticipants.map((row) => [row.id, row] as const));

  const personIdByClubspotParticipantId = new Map<string, string>();
  const newParticipants: Pick<ParticipantRow, "id" | "person_id" | "last_sync_run_id">[] = [];

  for (const registration of data.registrations) {
    const participant = firstParticipant(registration);
    if (!participant) {
      continue;
    }
    const existingParticipant = existingParticipantById.get(participant.id);
    const resolved = await personSync.syncParticipant(participant, existingParticipant?.person_id ?? undefined);
    personIdByClubspotParticipantId.set(participant.id, resolved.id);
    if (resolved.created) {
      // PersonSync also writes contacts and a medical profile as part of the same call, but
      // doesn't report their counts, so this undercounts - it's a coarse total, not an audit log.
      created++;
    }
    if (!existingParticipant) {
      const newParticipant = { id: participant.id, person_id: resolved.id, last_sync_run_id: runId ?? null };
      newParticipants.push(newParticipant);
      existingParticipantById.set(participant.id, newParticipant as ParticipantRow);
    }
  }

  if (newParticipants.length > 0) {
    await directus.createItems<Pick<ParticipantRow, "id" | "person_id" | "last_sync_run_id">>(
      "participants",
      newParticipants,
    );
  }

  const registrationPlan = planRegistrations(data.registrations, personIdByClubspotParticipantId, tables.registrations);
  const registrationResult = await applyPlan(directus, "registrations", registrationPlan, tables.registrations);
  tables.registrations = registrationResult.rows;
  created += registrationResult.created;
  updated += registrationResult.updated;
  skipped += registrationResult.skipped;
  const syncedRegistrationIds = new Set(tables.registrations.map((row) => row.id));

  const knownSessionIds = new Set(tables.sessions.map((row) => row.id));

  for (const registration of data.registrations) {
    if (!syncedRegistrationIds.has(registration.id)) {
      // No participant, so planRegistrations skipped it - nothing downstream to sync yet.
      continue;
    }
    const registrationCrmId = registration.id;

    const entryPlan = planRegistrationEntries(
      registration,
      registrationCrmId,
      knownSessionIds,
      tables.registrationEntries,
    );
    const entryResult = await applyPlan(directus, "registration_entries", entryPlan, tables.registrationEntries);
    tables.registrationEntries = entryResult.rows;
    created += entryResult.created;
    updated += entryResult.updated;
    skipped += entryResult.skipped;

    const billingPlan = planRegistrationBilling(registration, registrationCrmId, tables.registrationBilling);
    const billingResult = await applyRegistrationBillingPlan(directus, billingPlan, tables.registrationBilling);
    tables.registrationBilling = billingResult.rows;
    created += billingResult.created;
    updated += billingResult.updated;

    const responsePlan = planCustomFieldResponses(
      registration,
      registrationCrmId,
      knownDefinitionIds,
      tables.customFieldResponses,
    );
    const responseResult = await applyPlan(
      directus,
      "custom_field_responses",
      responsePlan,
      tables.customFieldResponses,
    );
    tables.customFieldResponses = responseResult.rows;
    created += responseResult.created;
    updated += responseResult.updated;
    skipped += responseResult.skipped;
  }

  return { created, updated, skipped, participantsCreated: newParticipants.length };
}

/** The schedule and registration passes for one camp, against its own shared-table state. */
async function runCampPasses(
  data: CampData,
  tables: SharedTables,
  directus: DirectusClient,
  personSync: PersonSync,
  runId: string | undefined,
): Promise<{ counts: CampSyncCounts }> {
  const schedule = await syncSchedule(data, tables, directus);
  const registrations = await syncRegistrations(data, tables, directus, personSync, runId);

  return {
    counts: {
      created: schedule.counts.created + registrations.created,
      updated: schedule.counts.updated + registrations.updated,
      skipped: schedule.counts.skipped + registrations.skipped,
      participantsCreated: registrations.participantsCreated,
    },
  };
}

/**
 * Copies custom field responses onto `people` columns, once per run after every camp has had
 * its chance to sync - the winning response for a person can come from any camp, so this can't
 * run per-camp. Reads `promoted_fields` and a two-column projection of `people`, plus the three
 * collections `planPromotedFields` ranks candidates from.
 */
async function promotePeopleFields(directus: DirectusClient): Promise<number> {
  const [customFieldDefinitions, customFieldResponses, registrations, promotedFields, people] = await Promise.all([
    // Unscoped: the winning custom-field response for a person can come from any camp, so this
    // pass needs every camp's rows, not one.
    directus.readItems<CustomFieldDefinitionRow>("custom_field_definitions", { limit: -1 }),
    directus.readItems<CustomFieldResponseRow>("custom_field_responses", { limit: -1 }),
    directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
    directus.readItems<PromotedFieldRow>("promoted_fields", { limit: -1 }),
    directus.readItems<PersonRow>("people", { limit: -1, fields: ["id", "school"] }),
  ]);

  const patches = planPromotedFields(
    promotedFields,
    customFieldDefinitions,
    customFieldResponses,
    registrations,
    people,
  );

  for (const { id, patch } of patches) {
    await directus.updateItem<PersonRow>("people", id, patch);
  }

  return patches.length;
}

export interface SyncCampOptions {
  camp: Camp;
  /**
   * Overrides the camp's stored `synced_through` for the registration query, so a backfill
   * re-reads registrations Clubspot last touched before the camp's last successful sync. The
   * schedule pass is unaffected - it's already a full reconcile every run.
   */
  since?: Date;
  /** `--camp` bypasses the backoff check, for a manual verification or backfill run. */
  bypassBackoff?: boolean;
  directus: DirectusClient;
  personSync: PersonSync;
  gateway: Pick<SyncGateway, "fetchCampData">;
  /** This execution's `sync_runs` id, if any - threaded down to `participants.last_sync_run_id`. */
  runId?: string;
}

export type SyncCampOutcome = { status: "skipped" } | { status: "synced"; campCrmId: string; counts: CampSyncCounts };

/**
 * One camp's full reconcile: the schedule and registration passes, then the camp's own
 * watermark and backoff state. Every call re-reads the shared tables, since camps sync
 * independently through the queue now and there's no run-scoped in-memory state to reuse - scoped
 * to this camp, so the read no longer grows with every other camp the club has (#135).
 */
export async function syncCamp(options: SyncCampOptions): Promise<SyncCampOutcome> {
  const { camp, since, bypassBackoff, directus, personSync, gateway, runId } = options;

  // `startedAt`, not the run's own trigger time, bounds the query below: it's the same value this
  // call records as the camp's `synced_through`, so the next sync's watermark picks up exactly
  // where this one's window left off. A camp earlier in the same run (or a slow shared-table
  // read) can otherwise widen the gap between the two.
  const startedAt = new Date();

  const tables = await readSharedTables(directus, { clubspotCampId: camp.id });
  const existing = tables.camps.find((row) => row.id === camp.id);

  if (!bypassBackoff) {
    const { due } = campBackoff(existing ?? { synced_through: null, quiet_runs: 0 }, startedAt);
    if (!due) {
      return { status: "skipped" };
    }
  }

  const watermark = since ?? (existing?.synced_through ? new Date(existing.synced_through) : EPOCH);
  const data = await gateway.fetchCampData(camp, watermark, startedAt);
  const { counts } = await runCampPasses(data, tables, directus, personSync, runId);

  const wroteSomething = counts.created > 0 || counts.updated > 0;
  await directus.updateItem<CampWithClubspot>(
    "camps",
    camp.id,
    nextSyncState(existing?.quiet_runs ?? 0, wroteSomething, startedAt),
  );

  return { status: "synced", campCrmId: camp.id, counts };
}

export interface RunSyncOptions {
  clubId: string;
  /** Syncs only this camp, bypassing discovery, the queue, and the backoff check. */
  campId?: string;
  /** Requires `campId` - see `SyncCampOptions.since`. */
  since?: Date;
  now: Date;
  directus: DirectusClient;
  queue: SyncQueue;
  personSync: PersonSync;
  gateway: SyncGateway;
}

export interface RunSyncResult {
  status: "ok" | "failed";
  campsChecked: number;
  campsFailed: number;
  participantsCreated: number;
  peoplePromoted: number;
  /** Unset only for a dry run, whose `sync_runs` create no-ops and returns no id. */
  syncRunId?: string;
}

/**
 * Starts this execution's `sync_runs` row. A dry run's `createItems` no-ops and returns the input
 * with no id (see `DirectusClient`); returning `undefined` there lets the caller skip the closing
 * update instead of trying to patch a row that was never written. A real run with no id back is a
 * write that silently failed, so it throws instead of limping on with no history.
 */
async function startSyncRun(directus: DirectusClient, startedAt: Date): Promise<SyncRunRow | undefined> {
  const [created] = await directus.createItems<SyncRunRow>("sync_runs", [
    { source: "clubspot-sync", started_at: startedAt.toISOString(), status: "running" },
  ]);
  if (!created?.id) {
    if (directus.isDryRun) {
      return undefined;
    }
    throw new Error("Directus did not return the created sync_runs row");
  }
  return created;
}

/** Closes out this execution's `sync_runs` row with its outcome. */
async function finishSyncRun(
  directus: DirectusClient,
  runId: string,
  finishedAt: Date,
  result: RunSyncResult,
  runError: string | undefined,
): Promise<void> {
  await directus.updateItem<SyncRunRow>("sync_runs", runId, {
    finished_at: finishedAt.toISOString(),
    status: result.status === "ok" ? "succeeded" : "failed",
    counts: {
      campsChecked: result.campsChecked,
      campsFailed: result.campsFailed,
      participantsCreated: result.participantsCreated,
      peoplePromoted: result.peoplePromoted,
    },
    error: runError ?? null,
  });
}

/**
 * One camp's task handler: recovers the target Clubspot camp id `SyncQueue.enqueue` folded
 * into the task's key, then runs the same reconcile a direct `--camp` run does, respecting backoff.
 *
 * `getCamp` queries Clubspot by id directly, unlike `discoverCamps`'s `archived: false` filter (see
 * `camps.ts`) - so it fails only once a camp is genuinely gone, not merely archived, and an archived
 * camp still gets its normal reconcile. A genuinely gone camp can never come back on retry, so the
 * task retires as cancelled instead of failing.
 */
function campTaskHandler(
  directus: DirectusClient,
  personSync: PersonSync,
  gateway: SyncGateway,
  runId: string | undefined,
  /** Mutated in place: the queue drives each task independently, so this is the only way a task's own `participantsCreated` reaches the run-level total. */
  counts: { participantsCreated: number },
): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const campId = targetFromKey(task);
    const camp = await gateway.getCamp(campId).catch((error: unknown) => {
      throw new TaskOrphaned(
        `Camp ${campId} no longer exists in Clubspot: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const outcome = await syncCamp({
      camp,
      bypassBackoff: false,
      directus,
      personSync,
      gateway,
      ...(runId ? { runId } : {}),
    });
    if (outcome.status === "synced") {
      counts.participantsCreated += outcome.counts.participantsCreated;
    }
  };
}

/**
 * Discovers this club's camps and enqueues one `sync_camp` task per camp, each isolated to its
 * own retry schedule by the queue. The discovery step itself isn't a queue task: a task that
 * throws is silently retried later by the queue's own backoff, which is right for one camp's
 * transient failure but wrong for a broken run - discovery failing should surface immediately, the
 * same run it happened in, not get swallowed until the queue's retries exhaust.
 *
 * `sync_run`'s key stays keyed on `clubId` alone, so every run's tasks land under the same parent
 * row rather than piling up a new root every run - that's what keeps the tree in the Directus admin
 * UI readable. `runSync` no longer reads this run's outcome back out through `parent_id`, precisely
 * because a stable parent accumulates every camp ever enqueued under it, including ones discovery
 * has since stopped returning (#143 finding 4) - it tracks the ids this call actually enqueues instead.
 */
async function enqueueDueCamps(
  clubId: string,
  now: Date,
  directus: DirectusClient,
  queue: SyncQueue,
  gateway: Pick<SyncGateway, "discoverCamps">,
): Promise<string[]> {
  const run = await queue.enqueue({ queue: "clubspot-sync", kind: "sync_run", target: clubId }, now);
  const campTaskIds: string[] = [];
  try {
    const camps = await gateway.discoverCamps(clubId);
    for (const camp of camps) {
      const task = await queue.enqueue(
        { queue: "clubspot-sync", kind: "sync_camp", target: camp.id, parentId: run.id ?? null },
        now,
      );
      if (task.id) {
        campTaskIds.push(task.id);
      }
    }
    if (run.id) {
      await directus.updateItem<SyncTaskRow>("sync_tasks", run.id, { status: "done", finished_at: now.toISOString() });
    }
  } catch (error) {
    if (run.id) {
      await directus.updateItem<SyncTaskRow>("sync_tasks", run.id, {
        status: "failed",
        finished_at: now.toISOString(),
        last_error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  return campTaskIds;
}

/**
 * One job execution. `campId` (and dry-run previews) bypass discovery, the queue, and the backoff
 * check for a direct, synchronous reconcile of one camp - see `SyncCampOptions.bypassBackoff`.
 * Otherwise every non-archived camp is discovered and its sync enqueued, and the queue drives
 * each one on its own schedule, isolated from its siblings' failures. Either way, promoting custom
 * field responses onto `people` runs once at the end, reading fresh state rather than one run's
 * in-memory tables - there's no longer a single run's worth of state to carry, since camps sync
 * independently.
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { clubId, campId, since, now, directus, queue, personSync, gateway } = options;

  const syncRun = await startSyncRun(directus, now);

  let campsChecked = 0;
  let campsFailed = 0;
  let participantsCreated = 0;
  let runError: string | undefined;

  try {
    if (campId || directus.isDryRun) {
      const camps = campId ? [await gateway.getCamp(campId)] : await gateway.discoverCamps(clubId);
      campsChecked = camps.length;
      for (const camp of camps) {
        try {
          const outcome = await syncCamp({
            camp,
            bypassBackoff: Boolean(campId),
            directus,
            personSync,
            gateway,
            ...(syncRun?.id ? { runId: syncRun.id } : {}),
            ...(since ? { since } : {}),
          });
          if (outcome.status === "synced") {
            participantsCreated += outcome.counts.participantsCreated;
          }
        } catch (error) {
          campsFailed++;
          winston.error("Camp sync failed", {
            campId: camp.id,
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          });
        }
      }
    } else {
      const campTaskIds = await enqueueDueCamps(clubId, now, directus, queue, gateway);
      const queueCounts = { participantsCreated: 0 };
      const { taskIds: claimedTaskIds } = await runQueue(directus, "clubspot-sync", {
        sync_camp: campTaskHandler(directus, personSync, gateway, syncRun?.id, queueCounts),
      });
      participantsCreated += queueCounts.participantsCreated;

      // The union, not just what this run enqueued: a task left over from an earlier run - pending
      // a retry, or simply never claimable until now - is claimed here without being re-enqueued,
      // and still belongs in what this run reports on. What discovery no longer returns is absent
      // from both sets, so it drops out of the count instead of hanging on the stable sync_run
      // parent forever (#143 finding 4).
      const checkedTaskIds = [...new Set([...campTaskIds, ...claimedTaskIds])];
      campsChecked = checkedTaskIds.length;

      if (checkedTaskIds.length > 0) {
        const tasks = await directus.readItems<SyncTaskRow>("sync_tasks", {
          filter: { queue: { _eq: "clubspot-sync" } },
          limit: -1,
        });
        const taskById = new Map(tasks.filter((task) => task.id).map((task) => [task.id as string, task]));
        // Neither "done" nor "cancelled" is a failure worth surfacing: "cancelled" means the task's
        // own camp evaporated from Clubspot, not that anything is broken - see `TaskOrphaned`.
        // A task still "pending" is, whether it failed once or has been failing for weeks
        // (`needs_attention`) - the queue keeps retrying either way.
        campsFailed = checkedTaskIds.filter((id) => {
          const status = taskById.get(id)?.status;
          return status !== "done" && status !== "cancelled";
        }).length;
      }
    }
  } catch (error) {
    winston.error("Sync run failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  let peoplePromoted = 0;
  try {
    peoplePromoted = await promotePeopleFields(directus);
  } catch (error) {
    // Isolated from the camp loop above: a bad promoted_fields config must not be mistaken for
    // a camp's own result.
    winston.error("Promoting custom field responses to people columns failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = runError ?? (error instanceof Error ? error.message : String(error));
  }

  const status: "ok" | "failed" = runError !== undefined || campsFailed > 0 ? "failed" : "ok";
  const result: RunSyncResult = {
    status,
    campsChecked,
    campsFailed,
    participantsCreated,
    peoplePromoted,
    ...(syncRun?.id ? { syncRunId: syncRun.id } : {}),
  };

  if (syncRun?.id) {
    await finishSyncRun(directus, syncRun.id, new Date(), result, runError);
  }

  return result;
}

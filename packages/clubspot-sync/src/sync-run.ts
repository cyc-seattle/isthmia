import winston from "winston";
import { randomUUID } from "node:crypto";
import { Camp, CampClass, CampSession, EntryCap, Registration } from "@cyc-seattle/clubspot-sdk";
import { CustomFieldResponseRow, PersonRow, PromotedFieldRow, SessionClassRow } from "@cyc-seattle/crm";
import {
  DirectusClient,
  SyncQueue,
  SyncTaskHandler,
  SyncTaskRow,
  runQueue,
  targetFromKey,
  TaskOrphaned,
} from "@cyc-seattle/directus";
import { nextSyncState, offeringBackoff } from "./backoff.js";
import { PersonSync } from "./person-sync.js";
import { planPromotedFields } from "./promoted-fields.js";
import {
  CollectionPlan,
  planClasses,
  planEntryCaps,
  planOfferings,
  planSessionClasses,
  planSessions,
  requireLookup,
  SessionClassPlan,
} from "./schedule.js";
import {
  firstParticipant,
  planCustomFieldDefinitions,
  planCustomFieldResponses,
  planRegistrationBilling,
  planRegistrationEntries,
  planRegistrations,
} from "./registrations.js";
import {
  ClassWithClubspot,
  CustomFieldDefinitionWithClubspot,
  EntryCapWithClubspot,
  OfferingWithClubspot,
  RegistrationBillingWithClubspot,
  RegistrationEntryWithClubspot,
  RegistrationWithClubspot,
  SessionWithClubspot,
} from "./schema.js";

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
  offerings: OfferingWithClubspot[];
  classes: ClassWithClubspot[];
  sessions: SessionWithClubspot[];
  sessionClasses: SessionClassRow[];
  entryCaps: EntryCapWithClubspot[];
  customFieldDefinitions: CustomFieldDefinitionWithClubspot[];
  registrations: RegistrationWithClubspot[];
  registrationEntries: RegistrationEntryWithClubspot[];
  registrationBilling: RegistrationBillingWithClubspot[];
  customFieldResponses: CustomFieldResponseRow[];
}

/** Narrows every `readSharedTables` collection but `offerings` to the one offering for this Clubspot camp. */
interface OfferingScope {
  clubspotCampId: string;
}

function crmIds<Row extends { id?: string }>(rows: readonly Row[]): string[] {
  return rows.flatMap((row) => (row.id ? [row.id] : []));
}

// Directus 403s a dot-notation relational filter (`filter[registration_id.offering_id][_eq]`) on
// these five hop collections - it requires read permission on the traversed field itself, which
// this token doesn't have, independent of what's in `fields` (see #135 follow-up). Chunked `_in` is
// the fallback: a UUID plus its comma separator is ~37 characters, so 40 ids/batch keeps a request's
// id list under 1,480 characters - well under a conservative 2,000-character URL budget once the
// base URL, path, and other query params are added.
const ID_BATCH_SIZE = 40;

/**
 * Reads rows whose `field` matches one of `ids`, batching the `_in` list so no single request's URL
 * grows unbounded with the offering's size - an offering with no classes or registrations yet has
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
 * Reads every table the schedule and registration passes reconcile against, scoped to one offering
 * so an offering sync's read no longer grows with the club's whole history (#135) - fetching each
 * collection's state for just this offering and diffing it in avoids a Directus round trip per pass.
 * `classes`, `sessions`, `custom_field_definitions`, and `registrations` carry `offering_id`
 * directly; `session_classes` and `entry_caps` are reached through their classes'
 * (`entry_caps.session_id` can be null, but `class_id` never is); `registration_entries`,
 * `registration_billing`, and `custom_field_responses` are reached through their registrations.
 * `offerings` itself is the one exception - it has no `offering_id` to filter by, so it's just the
 * single row for `scope.clubspotCampId`, or none for an offering synced for the first time, in
 * which case every other table is empty too: nothing can reference an offering that doesn't exist
 * in the CRM yet.
 */
async function readSharedTables(directus: DirectusClient, scope: OfferingScope): Promise<SharedTables> {
  const offerings = await directus.readItems<OfferingWithClubspot>("offerings", {
    filter: { clubspot_camp_id: { _eq: scope.clubspotCampId } },
    limit: -1,
  });
  const offeringId = offerings[0]?.id;
  if (!offeringId) {
    return {
      offerings,
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
    directus.readItems<ClassWithClubspot>("classes", { filter: { offering_id: { _eq: offeringId } }, limit: -1 }),
    directus.readItems<SessionWithClubspot>("sessions", { filter: { offering_id: { _eq: offeringId } }, limit: -1 }),
    directus.readItems<CustomFieldDefinitionWithClubspot>("custom_field_definitions", {
      filter: { offering_id: { _eq: offeringId } },
      limit: -1,
    }),
    directus.readItems<RegistrationWithClubspot>("registrations", {
      filter: { offering_id: { _eq: offeringId } },
      limit: -1,
    }),
  ]);

  const classIds = crmIds(classes);
  const registrationIds = crmIds(registrations);

  const [sessionClasses, entryCaps, registrationEntries, registrationBilling, customFieldResponses] = await Promise.all(
    [
      readByIds<SessionClassRow>(directus, "session_classes", "class_id", classIds),
      readByIds<EntryCapWithClubspot>(directus, "entry_caps", "class_id", classIds),
      readByIds<RegistrationEntryWithClubspot>(directus, "registration_entries", "registration_id", registrationIds),
      readByIds<RegistrationBillingWithClubspot>(directus, "registration_billing", "registration_id", registrationIds),
      readByIds<CustomFieldResponseRow>(directus, "custom_field_responses", "registration_id", registrationIds),
    ],
  );

  return {
    offerings,
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
 * Writes a plan and folds the result back into `existing`, so the next plan for the same offering
 * sees it without a re-read.
 */
async function applyPlan<Row extends { id?: string }>(
  directus: DirectusClient,
  collection: string,
  plan: CollectionPlan<Row>,
  existing: Row[],
): Promise<ApplyResult<Row>> {
  const created = plan.toCreate.length > 0 ? await directus.createItems<Row>(collection, plan.toCreate as Row[]) : [];
  // A dry run's createItems returns the input rows with no id (see DirectusClient), but a later
  // stage in the same offering may need one to point a foreign key at - a session at its offering, say.
  // A placeholder id keeps that lookup working without ever writing it anywhere.
  const createdRows = created.map((row) => (row.id ? row : ({ ...row, id: randomUUID() } as Row)));

  for (const update of plan.toUpdate) {
    await directus.updateItem<Row>(collection, update.id, update.patch);
  }

  const patchById = new Map(plan.toUpdate.map((update) => [update.id, update.patch]));
  const rows = existing.map((row) => (row.id && patchById.has(row.id) ? { ...row, ...patchById.get(row.id) } : row));

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
  const created =
    plan.toCreate.length > 0 ? await directus.createItems<SessionClassRow>("session_classes", plan.toCreate) : [];
  const createdRows = created.map((row) => (row.id ? row : { ...row, id: randomUUID() }));

  for (const row of plan.toRemove) {
    if (row.id) {
      await directus.deleteItem("session_classes", row.id);
    }
  }

  const removedIds = new Set(plan.toRemove.map((row) => row.id));
  const rows = existing.filter((row) => !row.id || !removedIds.has(row.id));

  return { rows: [...rows, ...createdRows], created: createdRows.length, removed: plan.toRemove.length };
}

function indexByClubspotId<Row extends { id?: string }>(rows: readonly Row[], key: keyof Row): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string" && row.id) {
      map.set(value, row.id);
    }
  }
  return map;
}

export interface CampSyncCounts {
  created: number;
  updated: number;
  skipped: number;
}

interface ScheduleSyncResult {
  offeringId: string;
  classCrmIdByClubspotClassId: Map<string, string>;
  sessionCrmIdByClubspotSessionId: Map<string, string>;
  counts: CampSyncCounts;
}

/**
 * `offerings`, `sessions`, `classes`, `session_classes`, `entry_caps` - reconciled in full every
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

  const offeringPlan = planOfferings([data.camp], tables.offerings);
  const offeringResult = await applyPlan(directus, "offerings", offeringPlan, tables.offerings);
  tables.offerings = offeringResult.rows;
  created += offeringResult.created;
  updated += offeringResult.updated;
  const offeringCrmIdByClubspotCampId = indexByClubspotId(tables.offerings, "clubspot_camp_id");
  const offeringId = requireLookup(offeringCrmIdByClubspotCampId, data.camp.id, "offering");

  const sessionPlan = planSessions(data.sessions, offeringCrmIdByClubspotCampId, tables.sessions);
  const sessionResult = await applyPlan(directus, "sessions", sessionPlan, tables.sessions);
  tables.sessions = sessionResult.rows;
  created += sessionResult.created;
  updated += sessionResult.updated;
  const sessionCrmIdByClubspotSessionId = indexByClubspotId(tables.sessions, "clubspot_session_id");

  const classPlan = planClasses(data.classes, offeringCrmIdByClubspotCampId, tables.classes);
  const classResult = await applyPlan(directus, "classes", classPlan, tables.classes);
  tables.classes = classResult.rows;
  created += classResult.created;
  updated += classResult.updated;
  const classCrmIdByClubspotClassId = indexByClubspotId(tables.classes, "clubspot_class_id");

  const offeringClassCrmIds = data.classes.map((campClass) =>
    requireLookup(classCrmIdByClubspotClassId, campClass.id, "class"),
  );
  const sessionClassPlan = planSessionClasses(
    data.sessions,
    sessionCrmIdByClubspotSessionId,
    classCrmIdByClubspotClassId,
    offeringClassCrmIds,
    tables.sessionClasses,
  );
  const sessionClassResult = await applySessionClassPlan(directus, sessionClassPlan, tables.sessionClasses);
  tables.sessionClasses = sessionClassResult.rows;
  created += sessionClassResult.created;
  updated += sessionClassResult.removed; // A removal is a modification to the schedule, same bucket as an update.

  const entryCapPlan = planEntryCaps(
    data.entryCaps,
    classCrmIdByClubspotClassId,
    sessionCrmIdByClubspotSessionId,
    tables.entryCaps,
  );
  const entryCapResult = await applyPlan(directus, "entry_caps", entryCapPlan, tables.entryCaps);
  tables.entryCaps = entryCapResult.rows;
  created += entryCapResult.created;
  updated += entryCapResult.updated;
  skipped += entryCapResult.skipped;

  return {
    offeringId,
    classCrmIdByClubspotClassId,
    sessionCrmIdByClubspotSessionId,
    counts: { created, updated, skipped },
  };
}

/**
 * `custom_field_definitions`, `people`/`contacts`/`medical_profiles` (via `PersonSync`),
 * `registrations`, `registration_entries`, `registration_billing`, `custom_field_responses` -
 * filtered to what's in `data.registrations`, following `REGISTRATION_CREATE_ORDER`.
 */
async function syncRegistrations(
  data: CampData,
  offeringId: string,
  classCrmIdByClubspotClassId: Map<string, string>,
  sessionCrmIdByClubspotSessionId: Map<string, string>,
  tables: SharedTables,
  directus: DirectusClient,
  personSync: PersonSync,
): Promise<CampSyncCounts> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const offeringCrmIdByClubspotCampId = new Map([[data.camp.id, offeringId]]);

  const definitionPlan = planCustomFieldDefinitions(
    [data.camp],
    offeringCrmIdByClubspotCampId,
    tables.customFieldDefinitions,
  );
  const definitionResult = await applyPlan(
    directus,
    "custom_field_definitions",
    definitionPlan,
    tables.customFieldDefinitions,
  );
  tables.customFieldDefinitions = definitionResult.rows;
  created += definitionResult.created;
  updated += definitionResult.updated;
  const definitionCrmIdByClubspotCustomFieldId = indexByClubspotId(
    tables.customFieldDefinitions,
    "clubspot_custom_field_id",
  );

  // A registration already in the CRM has its person_id pinned at creation and never re-resolved,
  // so this is read before resolving any participant, and a registration that already exists
  // reuses its stored person_id rather than matching again.
  const existingPersonIdByClubspotRegistrationId = new Map(
    tables.registrations.map((row) => [row.clubspot_registration_id, row.person_id] as const),
  );

  // Person identity is resolved once per participant, before registrations.person_id (NOT NULL)
  // can be written.
  const personIdByClubspotParticipantId = new Map<string, string>();
  for (const registration of data.registrations) {
    const participant = firstParticipant(registration);
    if (!participant) {
      continue;
    }
    const existingPersonId = existingPersonIdByClubspotRegistrationId.get(registration.id);
    const resolved = await personSync.syncParticipant(participant, existingPersonId);
    personIdByClubspotParticipantId.set(participant.id, resolved.id);
    if (resolved.created) {
      // PersonSync also writes contacts and a medical profile as part of the same call, but
      // doesn't report their counts, so this undercounts - it's a coarse total, not an audit log.
      created++;
    }
  }

  const registrationPlan = planRegistrations(
    data.registrations,
    offeringCrmIdByClubspotCampId,
    personIdByClubspotParticipantId,
    tables.registrations,
  );
  const registrationResult = await applyPlan(directus, "registrations", registrationPlan, tables.registrations);
  tables.registrations = registrationResult.rows;
  created += registrationResult.created;
  updated += registrationResult.updated;
  skipped += registrationResult.skipped;
  const registrationCrmIdByClubspotRegistrationId = indexByClubspotId(tables.registrations, "clubspot_registration_id");

  for (const registration of data.registrations) {
    const registrationCrmId = registrationCrmIdByClubspotRegistrationId.get(registration.id);
    if (!registrationCrmId) {
      // No participant, so planRegistrations skipped it - nothing downstream to sync yet.
      continue;
    }

    const entryPlan = planRegistrationEntries(
      registration,
      registrationCrmId,
      classCrmIdByClubspotClassId,
      sessionCrmIdByClubspotSessionId,
      tables.registrationEntries,
    );
    const entryResult = await applyPlan(directus, "registration_entries", entryPlan, tables.registrationEntries);
    tables.registrationEntries = entryResult.rows;
    created += entryResult.created;
    updated += entryResult.updated;
    skipped += entryResult.skipped;

    const billingPlan = planRegistrationBilling(registration, registrationCrmId, tables.registrationBilling);
    const billingResult = await applyPlan(directus, "registration_billing", billingPlan, tables.registrationBilling);
    tables.registrationBilling = billingResult.rows;
    created += billingResult.created;
    updated += billingResult.updated;

    const responsePlan = planCustomFieldResponses(
      registration,
      registrationCrmId,
      definitionCrmIdByClubspotCustomFieldId,
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

  return { created, updated, skipped };
}

async function syncCamp(
  data: CampData,
  tables: SharedTables,
  directus: DirectusClient,
  personSync: PersonSync,
): Promise<{ offeringId: string; counts: CampSyncCounts }> {
  const schedule = await syncSchedule(data, tables, directus);
  const registrations = await syncRegistrations(
    data,
    schedule.offeringId,
    schedule.classCrmIdByClubspotClassId,
    schedule.sessionCrmIdByClubspotSessionId,
    tables,
    directus,
    personSync,
  );

  return {
    offeringId: schedule.offeringId,
    counts: {
      created: schedule.counts.created + registrations.created,
      updated: schedule.counts.updated + registrations.updated,
      skipped: schedule.counts.skipped + registrations.skipped,
    },
  };
}

/**
 * Copies custom field responses onto `people` columns, once per run after every offering has had
 * its chance to sync - the winning response for a person can come from any offering, so this can't
 * run per-offering. Reads `promoted_fields` and a two-column projection of `people`, plus the three
 * collections `planPromotedFields` ranks candidates from.
 */
async function promotePeopleFields(directus: DirectusClient): Promise<number> {
  const [customFieldDefinitions, customFieldResponses, registrations, promotedFields, people] = await Promise.all([
    // Unscoped: the winning custom-field response for a person can come from any offering, so this
    // pass needs every offering's rows, not one.
    directus.readItems<CustomFieldDefinitionWithClubspot>("custom_field_definitions", { limit: -1 }),
    directus.readItems<CustomFieldResponseRow>("custom_field_responses", { limit: -1 }),
    directus.readItems<RegistrationWithClubspot>("registrations", { limit: -1 }),
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

export interface SyncOfferingOptions {
  camp: Camp;
  /**
   * Overrides the offering's stored `synced_through` for the registration query, so a backfill
   * re-reads registrations Clubspot last touched before the offering's last successful sync. The
   * schedule pass is unaffected - it's already a full reconcile every run.
   */
  since?: Date;
  /** `--camp` bypasses the backoff check, for a manual verification or backfill run. */
  bypassBackoff?: boolean;
  directus: DirectusClient;
  personSync: PersonSync;
  gateway: Pick<SyncGateway, "fetchCampData">;
}

export type SyncOfferingOutcome =
  | { status: "skipped" }
  | { status: "synced"; offeringId: string; counts: CampSyncCounts };

/**
 * One offering's full reconcile: the schedule and registration passes, then the offering's own
 * watermark and backoff state. Every call re-reads the shared tables, since offerings sync
 * independently through the queue now and there's no run-scoped in-memory state to reuse - scoped
 * to this offering, so the read no longer grows with every other offering the club has (#135).
 */
export async function syncOffering(options: SyncOfferingOptions): Promise<SyncOfferingOutcome> {
  const { camp, since, bypassBackoff, directus, personSync, gateway } = options;

  // `startedAt`, not the run's own trigger time, bounds the query below: it's the same value this
  // call records as the offering's `synced_through`, so the next sync's watermark picks up exactly
  // where this one's window left off. An offering earlier in the same run (or a slow shared-table
  // read) can otherwise widen the gap between the two.
  const startedAt = new Date();

  const tables = await readSharedTables(directus, { clubspotCampId: camp.id });
  const existing = tables.offerings.find((row) => row.clubspot_camp_id === camp.id);

  if (!bypassBackoff) {
    const { due } = offeringBackoff(existing ?? { synced_through: null, quiet_runs: 0 }, startedAt);
    if (!due) {
      return { status: "skipped" };
    }
  }

  const watermark = since ?? (existing?.synced_through ? new Date(existing.synced_through) : EPOCH);
  const data = await gateway.fetchCampData(camp, watermark, startedAt);
  const { offeringId, counts } = await syncCamp(data, tables, directus, personSync);

  const wroteSomething = counts.created > 0 || counts.updated > 0;
  await directus.updateItem<OfferingWithClubspot>(
    "offerings",
    offeringId,
    nextSyncState(existing?.quiet_runs ?? 0, wroteSomething, startedAt),
  );

  return { status: "synced", offeringId, counts };
}

export interface RunSyncOptions {
  clubId: string;
  /** Syncs only this offering, bypassing discovery, the queue, and the backoff check. */
  campId?: string;
  /** Requires `campId` - see `SyncOfferingOptions.since`. */
  since?: Date;
  now: Date;
  directus: DirectusClient;
  queue: SyncQueue;
  personSync: PersonSync;
  gateway: SyncGateway;
}

export interface RunSyncResult {
  status: "ok" | "failed";
  offeringsChecked: number;
  offeringsFailed: number;
  peoplePromoted: number;
}

/**
 * One offering's task handler: recovers the target Clubspot camp id `SyncQueue.enqueue` folded
 * into the task's key, then runs the same reconcile a direct `--camp` run does, respecting backoff.
 *
 * `getCamp` queries Clubspot by id directly, unlike `discoverCamps`'s `archived: false` filter (see
 * `camps.ts`) - so it fails only once a camp is genuinely gone, not merely archived, and an archived
 * camp still gets its normal reconcile. A genuinely gone camp can never come back on retry, so the
 * task retires as cancelled instead of failing.
 */
function offeringTaskHandler(directus: DirectusClient, personSync: PersonSync, gateway: SyncGateway): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const campId = targetFromKey(task);
    const camp = await gateway.getCamp(campId).catch((error: unknown) => {
      throw new TaskOrphaned(
        `Camp ${campId} no longer exists in Clubspot: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await syncOffering({ camp, bypassBackoff: false, directus, personSync, gateway });
  };
}

/**
 * Discovers this club's camps and enqueues one `sync_offering` task per camp, each isolated to its
 * own retry schedule by the queue. The discovery step itself isn't a queue task: a task that
 * throws is silently retried later by the queue's own backoff, which is right for one offering's
 * transient failure but wrong for a broken run - discovery failing should surface immediately, the
 * same run it happened in, not get swallowed until the queue's retries exhaust.
 *
 * `sync_run`'s key stays keyed on `clubId` alone, so every run's tasks land under the same parent
 * row rather than piling up a new root every run - that's what keeps the tree in the Directus admin
 * UI readable. `runSync` no longer reads this run's outcome back out through `parent_id`, precisely
 * because a stable parent accumulates every camp ever enqueued under it, including ones discovery
 * has since stopped returning (#143 finding 4) - it tracks the ids this call actually enqueues instead.
 */
async function enqueueDueOfferings(
  clubId: string,
  now: Date,
  directus: DirectusClient,
  queue: SyncQueue,
  gateway: Pick<SyncGateway, "discoverCamps">,
): Promise<string[]> {
  const run = await queue.enqueue({ queue: "clubspot-sync", kind: "sync_run", target: clubId }, now);
  const offeringTaskIds: string[] = [];
  try {
    const camps = await gateway.discoverCamps(clubId);
    for (const camp of camps) {
      const task = await queue.enqueue(
        { queue: "clubspot-sync", kind: "sync_offering", target: camp.id, parentId: run.id ?? null },
        now,
      );
      if (task.id) {
        offeringTaskIds.push(task.id);
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
  return offeringTaskIds;
}

/**
 * One job execution. `campId` (and dry-run previews) bypass discovery, the queue, and the backoff
 * check for a direct, synchronous reconcile of one offering - see `SyncOfferingOptions.bypassBackoff`.
 * Otherwise every non-archived camp is discovered and its offering enqueued, and the queue drives
 * each one on its own schedule, isolated from its siblings' failures. Either way, promoting custom
 * field responses onto `people` runs once at the end, reading fresh state rather than one run's
 * in-memory tables - there's no longer a single run's worth of state to carry, since offerings sync
 * independently.
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { clubId, campId, since, now, directus, queue, personSync, gateway } = options;

  let offeringsChecked = 0;
  let offeringsFailed = 0;
  let runError: string | undefined;

  try {
    if (campId || directus.isDryRun) {
      const camps = campId ? [await gateway.getCamp(campId)] : await gateway.discoverCamps(clubId);
      offeringsChecked = camps.length;
      for (const camp of camps) {
        try {
          await syncOffering({
            camp,
            bypassBackoff: Boolean(campId),
            directus,
            personSync,
            gateway,
            ...(since ? { since } : {}),
          });
        } catch (error) {
          offeringsFailed++;
          winston.error("Offering sync failed", {
            campId: camp.id,
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          });
        }
      }
    } else {
      const offeringTaskIds = await enqueueDueOfferings(clubId, now, directus, queue, gateway);
      const { taskIds: claimedTaskIds } = await runQueue(directus, "clubspot-sync", {
        sync_offering: offeringTaskHandler(directus, personSync, gateway),
      });

      // The union, not just what this run enqueued: a task left over from an earlier run - pending
      // a retry, or simply never claimable until now - is claimed here without being re-enqueued,
      // and still belongs in what this run reports on. What discovery no longer returns is absent
      // from both sets, so it drops out of the count instead of hanging on the stable sync_run
      // parent forever (#143 finding 4).
      const checkedTaskIds = [...new Set([...offeringTaskIds, ...claimedTaskIds])];
      offeringsChecked = checkedTaskIds.length;

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
        offeringsFailed = checkedTaskIds.filter((id) => {
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
    // Isolated from the offering loop above: a bad promoted_fields config must not be mistaken for
    // an offering's own result.
    winston.error("Promoting custom field responses to people columns failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = runError ?? (error instanceof Error ? error.message : String(error));
  }

  const status: "ok" | "failed" = runError !== undefined || offeringsFailed > 0 ? "failed" : "ok";
  return { status, offeringsChecked, offeringsFailed, peoplePromoted };
}

import winston from "winston";
import { Camp, CampClass, CampSession, EntryCap, Participant, Registration } from "@cyc-seattle/clubspot-sdk";
import { PersonRow } from "@cyc-seattle/crm";
import {
  ClassRow,
  ContactPointWithParticipant,
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  EntryCapRow,
  ParticipantRow,
  PromotablePersonField,
  PromotedFieldRow,
  RegistrationBillingRow,
  RegistrationRow,
  SessionClassRow,
  SessionRow,
} from "@cyc-seattle/clubspot";
import {
  AuditFindingRow,
  DirectusClient,
  fingerprintFinding,
  finishSyncRun,
  planAuditFindingWrites,
  startSyncRun,
  SyncQueue,
  SyncRunOutcome,
  SyncTaskHandler,
  SyncTaskRow,
  runQueue,
  targetFromKey,
  TaskOrphaned,
} from "@cyc-seattle/directus";
import { AUDIT_FINDING_KINDS, findDuplicatePersonFindings, findUnlinkedParticipantFindings } from "./audit.js";
import { campBackoff, nextSyncState } from "./backoff.js";
import { contactPointKeySet, planStaffContactPoints } from "./contact-points.js";
import { readByIds } from "./directus-batch.js";
import { findDuplicatePeople, MERGE_PERSON_FIELDS, MergePerson } from "./merge.js";
import { runApprovedPersonMerges } from "./merge-executor.js";
import { buildParticipantMirrorFields, mergeParticipantMirrorFields, ParticipantMirrorFields } from "./people.js";
import { BatchSibling, logReplacedFields, PersonSync, ResolvedPerson } from "./person-sync.js";
import {
  buildTargetByDefinitionId,
  needsFallbackTargetValues,
  planPromotedFields,
  planPromotedFieldSync,
  trimmedValue,
} from "./promoted-fields.js";
import {
  CollectionPlan,
  diffFields,
  planCamps,
  planClasses,
  planEntryCaps,
  planSessionClasses,
  planSessions,
  SessionClassPlan,
} from "./schedule.js";
import {
  CustomFieldResponseInput,
  firstParticipant,
  planCustomFieldDefinitions,
  planCustomFieldResponses,
  planRegistrationBilling,
  planRegistrationEntries,
  planRegistrations,
  RegistrationBillingPlan,
} from "./registrations.js";
import { CampWithClubspot, RegistrationEntryWithClubspot } from "./schema.js";
import { RegistrationRank } from "./synced-fields.js";

/** No prior successful sync: the registration window starts from the beginning of Clubspot history. */
export const EPOCH = new Date(0);

/** A stored `custom_field_responses` row, in the raw shape `planPromotedFieldSync`'s fallback expects. */
function toResponseInput(row: CustomFieldResponseRow): CustomFieldResponseInput {
  return row.value == null
    ? { customFieldID: row.definition_id }
    : { customFieldID: row.definition_id, response: row.value };
}

/**
 * A fallback registration's own raw responses - read from the batch first (a same-batch sibling's
 * `custom_field_responses` haven't been written yet, see `syncRegistrations`'s pass 1), then this
 * camp's own already-loaded `tables`, and only then a direct read - the fallback can belong to a
 * different camp than the one being synced, which `tables` doesn't cover.
 */
async function fallbackRawResponses(
  directus: DirectusClient,
  fallbackRegistrationId: string,
  rawResponsesByRegistrationId: ReadonlyMap<string, readonly CustomFieldResponseInput[]>,
  tables: Pick<SharedTables, "customFieldResponses">,
): Promise<readonly CustomFieldResponseInput[]> {
  const batchRaw = rawResponsesByRegistrationId.get(fallbackRegistrationId);
  if (batchRaw) {
    return batchRaw;
  }
  const sameCampRows = tables.customFieldResponses.filter((row) => row.registration_id === fallbackRegistrationId);
  if (sameCampRows.length > 0) {
    return sameCampRows.map(toResponseInput);
  }
  const otherCampRows = await directus.readItems<CustomFieldResponseRow>("custom_field_responses", {
    filter: { registration_id: { _eq: fallbackRegistrationId } },
    limit: -1,
  });
  return otherCampRows.map(toResponseInput);
}

/**
 * Resolves a fallback registration's raw responses to target-field values, by re-running
 * `buildTargetByDefinitionId` against exactly the definitions those responses reference. A
 * fallback registration can belong to a different camp, whose custom field definitions were
 * cloned with different ids (see `buildTargetByDefinitionId`'s note), so its responses can't be
 * resolved against the current camp's own `targetByDefinitionId`.
 */
async function resolveFallbackTargetValues(
  directus: DirectusClient,
  promotedFieldsConfig: readonly PromotedFieldRow[],
  responses: readonly CustomFieldResponseInput[],
): Promise<Map<PromotablePersonField, string>> {
  const values = new Map<PromotablePersonField, string>();
  const definitionIds = [...new Set(responses.map((response) => response.customFieldID))];
  if (promotedFieldsConfig.length === 0 || definitionIds.length === 0) {
    return values;
  }
  const definitions = await readByIds<CustomFieldDefinitionRow>(
    directus,
    "custom_field_definitions",
    "id",
    definitionIds,
  );
  const targetByDefinitionId = buildTargetByDefinitionId(promotedFieldsConfig, definitions);
  for (const response of responses) {
    const targetField = targetByDefinitionId.get(response.customFieldID);
    const value = trimmedValue(response.response ?? null);
    if (targetField && value) {
      values.set(targetField, value);
    }
  }
  return values;
}

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
  participantsMirrored: number;
  contactPointsCreated: number;
  contactPointsTouched: number;
  /** The one CRM field rule's own tally (#137) - see `synced-fields.ts`. */
  fieldsWritten: number;
  fieldsReplacedStaffEdits: number;
  fieldsBlankSkipped: number;
  /** A guardian or emergency-contact slot whose name no longer matched its linked person - skipped, not applied. */
  slotNameMismatches: number;
  /** An existing participant whose person link was cleared - mirror updated, matcher and every CRM write skipped. */
  participantsUnlinkedSkipped: number;
}

type RegistrationSyncCounts = Omit<CampSyncCounts, "created" | "updated" | "skipped">;

interface ScheduleSyncResult {
  counts: Omit<CampSyncCounts, keyof RegistrationSyncCounts>;
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

  // `promoted_fields` is staff config, unscoped by camp - small enough to re-read per camp sync.
  // Mapped against this camp's own definitions, since a promoted label's definition id is only
  // ever good for the camp it was cloned onto (see `buildTargetByDefinitionId`). Caught here, not
  // let propagate: a broken read must not fail this camp's whole sync, same as the run-level
  // `promotePeopleFields` pass is isolated from the camp loop's own result - an empty map just
  // means this camp's registrations skip the promoted-fields sync this run.
  let targetByDefinitionId: ReadonlyMap<string, PromotablePersonField> = new Map();
  // Kept alongside `targetByDefinitionId`: a fallback registration's own responses can belong to a
  // different camp's cloned definitions (`buildTargetByDefinitionId`'s note above), so resolving
  // its target fields needs this same config run again against that camp's definitions - see
  // `resolveFallbackTargetValues`.
  let promotedFieldsConfig: readonly PromotedFieldRow[] = [];
  try {
    promotedFieldsConfig = await directus.readItems<PromotedFieldRow>("promoted_fields", { limit: -1 });
    targetByDefinitionId = buildTargetByDefinitionId(promotedFieldsConfig, tables.customFieldDefinitions);
  } catch (error) {
    winston.error("Reading promoted_fields for this camp's sync failed; skipping its promoted-fields sync", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
  }

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
  // Every person this camp's registrations resolved or matched - the run-level contact_points
  // backfill below (design doc "Every email and phone") batches its read over this set instead of
  // scanning every person in the CRM, same reasoning as `readSharedTables`'s per-camp scoping.
  const touchedPersonIds = new Set<string>();
  // Whether this registration currently outranks every other one linked to its person - the
  // per-registration promoted-fields sync below reuses it, same as `people` and
  // `medical_profiles` do inside `PersonSync`.
  const isNewestByRegistrationId = new Map<string, boolean>();
  // The registration this run's fallback base was drawn from, if any - see `PersonSync`'s
  // `fallbackRegistrationId`. The promoted-fields sync below reuses it the same way.
  const fallbackRegistrationIdByRegistrationId = new Map<string, string>();
  // Every registration's own raw responses, keyed by registration id - so a batch sibling's
  // fallback response is available even when it hasn't been written to `custom_field_responses`
  // yet (see the "same-batch race" note below).
  const rawResponsesByRegistrationId = new Map<string, readonly CustomFieldResponseInput[]>();
  const newParticipants: ParticipantRow[] = [];
  const participantUpdates: { id: string; patch: Partial<ParticipantRow> }[] = [];
  let participantsMirrored = 0;
  let contactPointsCreated = 0;
  let contactPointsTouched = 0;
  let fieldsWritten = 0;
  let fieldsReplacedStaffEdits = 0;
  let fieldsBlankSkipped = 0;
  let slotNameMismatches = 0;
  let participantsUnlinkedSkipped = 0;

  // Pass 1: resolve (match, reuse, or create) every registration's person, without touching any
  // curated field yet. `participants` rows for a genuinely new registration aren't written until
  // after pass 2, so an isNewest ranking that only reads what's already in Directus would let two
  // registrations newly linked to the same person in this same batch both count as newest, and
  // whichever is processed last would win regardless of which is actually newer (#137). Resolving
  // every person first, and ranking pass 2 against the whole batch, fixes that.
  interface ResolvedRegistration {
    registration: Registration;
    participant: Participant;
    mirrorFields: ParticipantMirrorFields;
    registrationRank: RegistrationRank;
    personId: string;
    created: boolean;
  }

  /** An existing participant whose person link was cleared - staff deleted the linked person, or unmerged it away. */
  interface UnlinkedRegistration {
    participant: Participant;
    existingParticipant: ParticipantRow;
    mirrorFields: ParticipantMirrorFields;
  }

  const resolvedRegistrations: ResolvedRegistration[] = [];
  // A registration already linked to a participant with no `person_id` (`SET NULL` when staff
  // delete a person) never re-runs the matcher - only a participant `sync-run.ts` is about to
  // create does (design doc "A participants mirror"). `unlinked_participant` (`audit.ts`) is what
  // tells staff to relink it by hand; a fresh match here would just as silently drift onto a new
  // or wrong person every run instead.
  const unlinkedRegistrations: UnlinkedRegistration[] = [];
  const unlinkedParticipantIds = new Set<string>();
  // Two registrations can share one Clubspot participant in the same batch (e.g. two sessions of
  // the same camp). Resolving the person only once per participant id, and every later
  // registration reusing that same resolution, is what keeps pass 2 from queuing a second
  // `participants` create with the same PK (#137 review finding 3).
  const resolvedPersonByParticipantId = new Map<string, ResolvedPerson>();
  for (const registration of data.registrations) {
    const participant = firstParticipant(registration);
    if (!participant) {
      continue;
    }
    const existingParticipant = existingParticipantById.get(participant.id);
    const mirrorFields = buildParticipantMirrorFields(participant);

    if (existingParticipant && existingParticipant.person_id === null) {
      if (!unlinkedParticipantIds.has(participant.id)) {
        unlinkedParticipantIds.add(participant.id);
        unlinkedRegistrations.push({ participant, existingParticipant, mirrorFields });
        participantsUnlinkedSkipped++;
      }
      rawResponsesByRegistrationId.set(registration.id, participant.get("customFieldsArray") ?? []);
      continue;
    }

    const registrationRank: RegistrationRank = {
      id: registration.id,
      archived: registration.get("archived") ?? false,
      registered_at: registration.get("confirmed_at")?.toISOString() ?? EPOCH.toISOString(),
    };
    const priorResolution = resolvedPersonByParticipantId.get(participant.id);
    const personResolution =
      priorResolution ??
      (await personSync.resolveParticipant(participant, {
        ...(existingParticipant?.person_id ? { existingPersonId: existingParticipant.person_id } : {}),
      }));
    if (!priorResolution) {
      resolvedPersonByParticipantId.set(participant.id, personResolution);
    }
    resolvedRegistrations.push({
      registration,
      participant,
      mirrorFields,
      registrationRank,
      personId: personResolution.id,
      // Only the first registration to resolve this participant in the batch can count as having
      // created its person - a later one reusing that same resolution never creates another.
      created: priorResolution === undefined && personResolution.created,
    });
    rawResponsesByRegistrationId.set(registration.id, participant.get("customFieldsArray") ?? []);
  }

  if (participantsUnlinkedSkipped > 0) {
    winston.warn(`Skipped CRM writes for ${participantsUnlinkedSkipped} participant(s) with no linked person`, {
      participantsUnlinkedSkipped,
    });
  }

  const batchSiblingsByPersonId = new Map<string, BatchSibling[]>();
  for (const resolved of resolvedRegistrations) {
    const siblings = batchSiblingsByPersonId.get(resolved.personId) ?? [];
    siblings.push({
      registration: resolved.registrationRank,
      participantId: resolved.participant.id,
      mirrorFields: resolved.mirrorFields,
    });
    batchSiblingsByPersonId.set(resolved.personId, siblings);
  }

  // Captured once, before this loop starts mutating `existingParticipantById`: the field rule's
  // `base` (#137) must be each registration's own stored answer as of the start of this run, not a
  // same-batch sibling's fresh write. Two *existing* registrations sharing a participant otherwise
  // let the second one processed compare against the first's own write - if the first processed
  // wasn't the newest, the newest would then see `base === v` and drop its real change as
  // "unchanged" (people-cleanup review finding 1).
  const priorMirrorById = new Map(existingParticipantById);

  // Pass 2: every person is now known, so rank each registration against the rest of its batch
  // and apply its curated fields.
  for (const {
    registration,
    participant,
    mirrorFields,
    registrationRank,
    personId,
    created: personCreated,
  } of resolvedRegistrations) {
    const batchSiblings = (batchSiblingsByPersonId.get(personId) ?? []).filter(
      (sibling) => sibling.participantId !== participant.id,
    );

    // Looked up fresh, not the pass 1 snapshot: two registrations can share one Clubspot
    // participant within a batch, and the second must see the first's own write from this same
    // batch to decide create vs. update below - not queue a second `participants` create with the
    // same PK (#137 review finding 3).
    const priorParticipant = existingParticipantById.get(participant.id);
    // The field rule's own base, unlike `priorParticipant` above - the pass 1 snapshot, so a
    // same-batch sibling's fresh mirror write never stands in for this registration's own stored
    // answer (see `priorMirrorById` above).
    const priorMirror = priorMirrorById.get(participant.id);

    // The mirror keeps Clubspot's last non-blank answer for every field (#137 review), unlike the
    // CRM row's own one-CRM-field rule - `mergeParticipantMirrorFields` is only what's written to
    // `participants` here; `mirrorFields` itself stays this run's raw `v` for `syncParticipant`
    // below. `last_sync_run_id` only moves in the same patch as an actual change, so an unchanged
    // participant carries no trace of a run that touched nothing of its. The CRM row is written
    // first and the mirror second, crash-safe: a rerun after a crash between the two sees the same
    // change and reapplies it harmlessly.
    const resolved = await personSync.syncParticipant(participant, {
      existingPersonId: personId,
      ...(priorMirror ? { priorMirror } : {}),
      mirrorFields,
      registration: registrationRank,
      batchSiblings,
    });
    personIdByClubspotParticipantId.set(participant.id, resolved.id);
    isNewestByRegistrationId.set(registration.id, resolved.isNewestParticipant);
    if (resolved.fallbackRegistrationId) {
      fallbackRegistrationIdByRegistrationId.set(registration.id, resolved.fallbackRegistrationId);
    }
    if (personCreated) {
      // PersonSync also writes contacts and a medical profile as part of the same call, but
      // doesn't report their counts, so this undercounts - it's a coarse total, not an audit log.
      created++;
    }
    contactPointsCreated += resolved.contactPointsCreated;
    contactPointsTouched += resolved.contactPointsTouched;
    fieldsWritten += resolved.fieldsWritten;
    fieldsReplacedStaffEdits += resolved.fieldsReplacedStaffEdits;
    fieldsBlankSkipped += resolved.fieldsBlankSkipped;
    slotNameMismatches += resolved.slotNameMismatches;
    for (const personId of resolved.touchedPersonIds) {
      touchedPersonIds.add(personId);
    }

    if (!priorParticipant) {
      const newParticipant: ParticipantRow = {
        id: participant.id,
        person_id: resolved.id,
        last_sync_run_id: runId ?? null,
        ...mirrorFields,
      };
      newParticipants.push(newParticipant);
      existingParticipantById.set(participant.id, newParticipant);
      participantsMirrored++;
    } else {
      const mergedFields = mergeParticipantMirrorFields(priorParticipant, mirrorFields);
      const patch = diffFields(priorParticipant, { ...priorParticipant, ...mergedFields });
      if (Object.keys(patch).length > 0) {
        const fullPatch: Partial<ParticipantRow> = { ...patch, last_sync_run_id: runId ?? null };
        participantUpdates.push({ id: participant.id, patch: fullPatch });
        existingParticipantById.set(participant.id, { ...priorParticipant, ...fullPatch });
        participantsMirrored++;
      }
    }
  }

  // Unlinked participants (pass 1) still get their mirror kept current - just never the matcher
  // or a CRM write, same blank-preserving merge as pass 2's existing-participant branch above.
  for (const { participant, existingParticipant, mirrorFields } of unlinkedRegistrations) {
    const mergedFields = mergeParticipantMirrorFields(existingParticipant, mirrorFields);
    const patch = diffFields(existingParticipant, { ...existingParticipant, ...mergedFields });
    if (Object.keys(patch).length > 0) {
      const fullPatch: Partial<ParticipantRow> = { ...patch, last_sync_run_id: runId ?? null };
      participantUpdates.push({ id: participant.id, patch: fullPatch });
      existingParticipantById.set(participant.id, { ...existingParticipant, ...fullPatch });
      participantsMirrored++;
    }
  }

  if (newParticipants.length > 0) {
    await directus.createItems<ParticipantRow>("participants", newParticipants);
  }
  for (const update of participantUpdates) {
    await directus.updateItem<ParticipantRow>("participants", update.id, update.patch);
  }

  const registrationPlan = planRegistrations(
    data.registrations,
    personIdByClubspotParticipantId,
    tables.registrations,
    unlinkedParticipantIds,
  );
  const registrationResult = await applyPlan(directus, "registrations", registrationPlan, tables.registrations);
  tables.registrations = registrationResult.rows;
  created += registrationResult.created;
  updated += registrationResult.updated;
  skipped += registrationResult.skipped;
  const syncedRegistrationIds = new Set(tables.registrations.map((row) => row.id));

  const knownSessionIds = new Set(tables.sessions.map((row) => row.id));

  // One batch read of every promotable field for every person this camp resolved, so the
  // per-registration promoted-fields sync below never fetches `people` in the entry/billing/
  // response loop - skipped entirely when nothing is configured to promote.
  const currentPromotableFieldsByPersonId = new Map<string, Partial<Record<PromotablePersonField, string | null>>>();
  if (targetByDefinitionId.size > 0) {
    const personIds = [...new Set(personIdByClubspotParticipantId.values())];
    const people = await readByIds<PersonRow>(directus, "people", "id", personIds);
    for (const person of people) {
      if (person.id) {
        currentPromotableFieldsByPersonId.set(person.id, person);
      }
    }
  }

  for (const registration of data.registrations) {
    if (!syncedRegistrationIds.has(registration.id)) {
      // No participant, so planRegistrations skipped it - nothing downstream to sync yet.
      continue;
    }
    const registrationCrmId = registration.id;
    const participant = firstParticipant(registration);

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

    // Captured before this registration's own custom_field_responses are overwritten below - the
    // `base` side of the promoted-fields rule, same as `participants` is for every other curated
    // field.
    const existingResponsesForRegistration = tables.customFieldResponses.filter(
      (row) => row.registration_id === registrationCrmId,
    );

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

    // A registration that isn't currently the newest linked to its person writes only its own
    // mirrored response, never the person's promoted column - same rule as `people` and
    // `medical_profiles`.
    const personId = participant ? personIdByClubspotParticipantId.get(participant.id) : undefined;
    if (personId && targetByDefinitionId.size > 0 && (isNewestByRegistrationId.get(registration.id) ?? false)) {
      const rawResponses: readonly CustomFieldResponseInput[] = participant?.get("customFieldsArray") ?? [];
      const currentPerson = currentPromotableFieldsByPersonId.get(personId) ?? {};
      // The previous newest *other* registration's own answer, by target field - the same
      // fallback base `PersonSync` draws `people`/`medical_profiles` from, so a newly linked
      // registration's first sync compares against its person's last known answer instead of only
      // filling a null column (#137).
      const fallbackRegistrationId = fallbackRegistrationIdByRegistrationId.get(registration.id);
      // Skipped whenever this registration's own stored responses already cover every promotable
      // one it sent - `resolveBase` only ever reaches for the fallback when a definition has no
      // stored row of its own yet, so reading the fallback registration's responses otherwise
      // would be a read this sync never uses (#137 review, read-volume finding).
      const fallbackByTargetField =
        fallbackRegistrationId &&
        needsFallbackTargetValues(targetByDefinitionId, rawResponses, existingResponsesForRegistration)
          ? await resolveFallbackTargetValues(
              directus,
              promotedFieldsConfig,
              await fallbackRawResponses(directus, fallbackRegistrationId, rawResponsesByRegistrationId, tables),
            )
          : new Map<PromotablePersonField, string>();
      const promotedPlan = planPromotedFieldSync(
        targetByDefinitionId,
        rawResponses,
        existingResponsesForRegistration,
        currentPerson,
        fallbackByTargetField,
      );
      if (Object.keys(promotedPlan.patch).length > 0) {
        await directus.updateItem<PersonRow>("people", personId, promotedPlan.patch);
        currentPromotableFieldsByPersonId.set(personId, { ...currentPerson, ...promotedPlan.patch });
      }
      logReplacedFields("people", personId, promotedPlan.replacedFields);
      fieldsWritten += promotedPlan.written;
      fieldsReplacedStaffEdits += promotedPlan.replacedStaffEdits;
      fieldsBlankSkipped += promotedPlan.blankSkipped;
    }
  }

  // Every `people.email`/`people.phone` should have a `contact_points` row (design doc "Every
  // email and phone: contact_points") - `PersonSync.writePersonPatch` only preserves a primary the
  // field rule is about to replace, so this batched pass covers the rest of what this camp
  // touched: a primary a form slot never resolved to (blank this run), or one set by staff and
  // never since replaced. Scoped to `touchedPersonIds`, not every person in the CRM.
  if (touchedPersonIds.size > 0) {
    const ids = [...touchedPersonIds];
    const [touchedPeople, existingContactPoints] = await Promise.all([
      readByIds<Pick<PersonRow, "id" | "email" | "phone">>(directus, "people", "id", ids, ["id", "email", "phone"]),
      readByIds<ContactPointWithParticipant>(directus, "contact_points", "person_id", ids),
    ]);
    const staffRows = planStaffContactPoints(touchedPeople, contactPointKeySet(existingContactPoints), new Date());
    if (staffRows.length > 0) {
      await directus.createItems<ContactPointWithParticipant>("contact_points", staffRows);
      contactPointsCreated += staffRows.length;
    }
  }

  return {
    created,
    updated,
    skipped,
    participantsCreated: newParticipants.length,
    participantsMirrored,
    contactPointsCreated,
    contactPointsTouched,
    fieldsWritten,
    fieldsReplacedStaffEdits,
    fieldsBlankSkipped,
    slotNameMismatches,
    participantsUnlinkedSkipped,
  };
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
      participantsMirrored: registrations.participantsMirrored,
      contactPointsCreated: registrations.contactPointsCreated,
      contactPointsTouched: registrations.contactPointsTouched,
      fieldsWritten: registrations.fieldsWritten,
      fieldsReplacedStaffEdits: registrations.fieldsReplacedStaffEdits,
      fieldsBlankSkipped: registrations.fieldsBlankSkipped,
      slotNameMismatches: registrations.slotNameMismatches,
      participantsUnlinkedSkipped: registrations.participantsUnlinkedSkipped,
    },
  };
}

/**
 * Copies custom field responses onto `people` columns, once per run after every camp has had
 * its chance to sync - the winning response for a person can come from any camp, so this can't
 * run per-camp. Reads `promoted_fields` and a two-column projection of `people`, plus the
 * collections `planPromotedFields` ranks candidates from.
 */
async function promotePeopleFields(directus: DirectusClient): Promise<number> {
  const [customFieldDefinitions, customFieldResponses, registrations, participants, promotedFields, people] =
    await Promise.all([
      // Unscoped: the winning custom-field response for a person can come from any camp, so this
      // pass needs every camp's rows, not one.
      directus.readItems<CustomFieldDefinitionRow>("custom_field_definitions", { limit: -1 }),
      directus.readItems<CustomFieldResponseRow>("custom_field_responses", { limit: -1 }),
      directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
      directus.readItems<ParticipantRow>("participants", { limit: -1, fields: ["id", "person_id"] }),
      directus.readItems<PromotedFieldRow>("promoted_fields", { limit: -1 }),
      directus.readItems<PersonRow>("people", { limit: -1, fields: ["id", "school"] }),
    ]);

  const patches = planPromotedFields(
    promotedFields,
    customFieldDefinitions,
    customFieldResponses,
    registrations,
    participants,
    people,
  );

  for (const { id, patch } of patches) {
    await directus.updateItem<PersonRow>("people", id, patch);
  }

  return patches.length;
}

interface AuditDetectionResult {
  raised: number;
  resolved: number;
}

/**
 * Raises `duplicate_person` and `unlinked_participant` findings, once per run after the camp
 * loop, and reconciles `audit_findings` against them (see `planAuditFindingWrites`). Scoped to the
 * two kinds this pass owns (`AUDIT_FINDING_KINDS`), so a finding some other sync raised - such as
 * gsuite-sync's own `class_without_program`, also tagged `source: "clubspot-sync"` - is left alone.
 * A reopened finding counts as raised again, same as a fresh one.
 */
async function detectAuditFindings(directus: DirectusClient): Promise<AuditDetectionResult> {
  const [people, participants] = await Promise.all([
    directus.readItems<MergePerson>("people", { fields: [...MERGE_PERSON_FIELDS], limit: -1 }),
    directus.readItems<Pick<ParticipantRow, "id" | "person_id" | "first_name" | "last_name">>("participants", {
      fields: ["id", "person_id", "first_name", "last_name"],
      limit: -1,
    }),
  ]);

  const participantsByPerson = new Map<string, { id: string }[]>();
  for (const participant of participants) {
    if (participant.person_id) {
      const forPerson = participantsByPerson.get(participant.person_id) ?? [];
      forPerson.push({ id: participant.id });
      participantsByPerson.set(participant.person_id, forPerson);
    }
  }

  const groups = findDuplicatePeople(people, participantsByPerson);
  const findings = [...findDuplicatePersonFindings(groups, people), ...findUnlinkedParticipantFindings(participants)];

  const existingRows = await directus.readItems<AuditFindingRow>("audit_findings", { limit: -1 });
  const { toCreate, toResolve, toReopen } = planAuditFindingWrites(findings, existingRows, AUDIT_FINDING_KINDS);

  if (toCreate.length > 0) {
    const rows = toCreate.map(
      (finding): Omit<AuditFindingRow, "id"> => ({
        ...finding,
        status: "open",
        fingerprint: fingerprintFinding(finding),
      }),
    );
    await directus.createItems<AuditFindingRow>("audit_findings", rows as AuditFindingRow[]);
  }
  for (const row of toResolve) {
    if (row.id) {
      await directus.updateItem<AuditFindingRow>("audit_findings", row.id, { status: "resolved" });
    }
  }
  for (const row of toReopen) {
    if (row.id) {
      await directus.updateItem<AuditFindingRow>("audit_findings", row.id, { status: "open" });
    }
  }

  return { raised: toCreate.length + toReopen.length, resolved: toResolve.length };
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
  participantsMirrored: number;
  contactPointsCreated: number;
  contactPointsTouched: number;
  peoplePromoted: number;
  /** The one CRM field rule's own tally (#137) - see `synced-fields.ts`. */
  fieldsWritten: number;
  fieldsReplacedStaffEdits: number;
  fieldsBlankSkipped: number;
  slotNameMismatches: number;
  participantsUnlinkedSkipped: number;
  /** `duplicate_person` and `unlinked_participant` findings this run raised or reopened. */
  auditFindingsRaised: number;
  /** Findings from an earlier run whose condition didn't recur this run. */
  auditFindingsResolved: number;
  /** Approved `duplicate_person` findings this run merged through to a deleted duplicate. */
  mergesApplied: number;
  /** Approved findings this run couldn't finish - a stale group, an unresolvable
   * `directus_user_id` conflict, or a duplicate a leftover reference still blocks - each reopened
   * rather than left silently `approved`. */
  mergesSkipped: number;
  /** Unset only for a dry run, whose `sync_runs` create no-ops and returns no id. */
  syncRunId?: string;
}

/** Maps a run's own result shape to the generic `counts`/`status`/`error` `finishSyncRun` writes. */
function toSyncRunOutcome(result: RunSyncResult, runError: string | undefined): SyncRunOutcome {
  return {
    status: result.status === "ok" ? "succeeded" : "failed",
    counts: {
      campsChecked: result.campsChecked,
      campsFailed: result.campsFailed,
      participantsCreated: result.participantsCreated,
      participantsMirrored: result.participantsMirrored,
      contactPointsCreated: result.contactPointsCreated,
      contactPointsTouched: result.contactPointsTouched,
      peoplePromoted: result.peoplePromoted,
      fieldsWritten: result.fieldsWritten,
      fieldsReplacedStaffEdits: result.fieldsReplacedStaffEdits,
      fieldsBlankSkipped: result.fieldsBlankSkipped,
      slotNameMismatches: result.slotNameMismatches,
      participantsUnlinkedSkipped: result.participantsUnlinkedSkipped,
      auditFindingsRaised: result.auditFindingsRaised,
      auditFindingsResolved: result.auditFindingsResolved,
      mergesApplied: result.mergesApplied,
      mergesSkipped: result.mergesSkipped,
    },
    error: runError,
  };
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
  /** Mutated in place: the queue drives each task independently, so this is the only way a task's own counts reach the run-level total. */
  counts: RegistrationSyncCounts,
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
      counts.participantsMirrored += outcome.counts.participantsMirrored;
      counts.contactPointsCreated += outcome.counts.contactPointsCreated;
      counts.contactPointsTouched += outcome.counts.contactPointsTouched;
      counts.fieldsWritten += outcome.counts.fieldsWritten;
      counts.fieldsReplacedStaffEdits += outcome.counts.fieldsReplacedStaffEdits;
      counts.fieldsBlankSkipped += outcome.counts.fieldsBlankSkipped;
      counts.slotNameMismatches += outcome.counts.slotNameMismatches;
      counts.participantsUnlinkedSkipped += outcome.counts.participantsUnlinkedSkipped;
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

  const syncRun = await startSyncRun(directus, "clubspot-sync", now);

  let runError: string | undefined;

  // Before the camp loop, so a merged person's records are consolidated before anything else this
  // run touches them (design doc "Merge, unmerge, and review", #133). Isolated the same way as the
  // promoted-fields and audit-detection passes below: its own failure must not be mistaken for a
  // camp's own result, but it does still mark the whole run failed, since an approved finding left
  // mid-merge needs the operator's attention same as any other run failure.
  let mergesApplied = 0;
  let mergesSkipped = 0;
  try {
    const merges = await runApprovedPersonMerges(directus);
    mergesApplied = merges.mergesApplied;
    mergesSkipped = merges.mergesSkipped;
  } catch (error) {
    winston.error("Applying approved duplicate_person merges failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  let campsChecked = 0;
  let campsFailed = 0;
  let participantsCreated = 0;
  let participantsMirrored = 0;
  let contactPointsCreated = 0;
  let contactPointsTouched = 0;
  let fieldsWritten = 0;
  let fieldsReplacedStaffEdits = 0;
  let fieldsBlankSkipped = 0;
  let slotNameMismatches = 0;
  let participantsUnlinkedSkipped = 0;

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
            participantsMirrored += outcome.counts.participantsMirrored;
            contactPointsCreated += outcome.counts.contactPointsCreated;
            contactPointsTouched += outcome.counts.contactPointsTouched;
            fieldsWritten += outcome.counts.fieldsWritten;
            fieldsReplacedStaffEdits += outcome.counts.fieldsReplacedStaffEdits;
            fieldsBlankSkipped += outcome.counts.fieldsBlankSkipped;
            slotNameMismatches += outcome.counts.slotNameMismatches;
            participantsUnlinkedSkipped += outcome.counts.participantsUnlinkedSkipped;
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
      const queueCounts: RegistrationSyncCounts = {
        participantsCreated: 0,
        participantsMirrored: 0,
        contactPointsCreated: 0,
        contactPointsTouched: 0,
        fieldsWritten: 0,
        fieldsReplacedStaffEdits: 0,
        fieldsBlankSkipped: 0,
        slotNameMismatches: 0,
        participantsUnlinkedSkipped: 0,
      };
      const { taskIds: claimedTaskIds } = await runQueue(directus, "clubspot-sync", {
        sync_camp: campTaskHandler(directus, personSync, gateway, syncRun?.id, queueCounts),
      });
      participantsCreated += queueCounts.participantsCreated;
      participantsMirrored += queueCounts.participantsMirrored;
      contactPointsCreated += queueCounts.contactPointsCreated;
      contactPointsTouched += queueCounts.contactPointsTouched;
      fieldsWritten += queueCounts.fieldsWritten;
      fieldsReplacedStaffEdits += queueCounts.fieldsReplacedStaffEdits;
      fieldsBlankSkipped += queueCounts.fieldsBlankSkipped;
      slotNameMismatches += queueCounts.slotNameMismatches;
      participantsUnlinkedSkipped += queueCounts.participantsUnlinkedSkipped;

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

  let auditFindingsRaised = 0;
  let auditFindingsResolved = 0;
  try {
    const detection = await detectAuditFindings(directus);
    auditFindingsRaised = detection.raised;
    auditFindingsResolved = detection.resolved;
  } catch (error) {
    // Isolated from the camp loop above, same as the promoted-fields pass: a bad read here must
    // not be mistaken for a camp's own result.
    winston.error("Detecting duplicate people and unlinked participants failed", {
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
    participantsMirrored,
    contactPointsCreated,
    contactPointsTouched,
    peoplePromoted,
    fieldsWritten,
    fieldsReplacedStaffEdits,
    fieldsBlankSkipped,
    slotNameMismatches,
    participantsUnlinkedSkipped,
    auditFindingsRaised,
    auditFindingsResolved,
    mergesApplied,
    mergesSkipped,
    ...(syncRun?.id ? { syncRunId: syncRun.id } : {}),
  };

  if (syncRun?.id) {
    await finishSyncRun(directus, syncRun.id, new Date(), toSyncRunOutcome(result, runError));
  }

  return result;
}

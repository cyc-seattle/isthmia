import winston from "winston";
import { randomUUID } from "node:crypto";
import { Camp, CampClass, CampSession, EntryCap, Registration } from "@cyc-seattle/clubspot-sdk";
import {
  ClassRow,
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  EntryCapRow,
  ProgramRow,
  RegistrationBillingRow,
  RegistrationEntryRow,
  RegistrationRow,
  SessionClassRow,
  SessionRow,
} from "@cyc-seattle/crm";
import { campBackoff } from "./backoff.js";
import { DirectusClient } from "./directus.js";
import { PersonSync } from "./person-sync.js";
import {
  CollectionPlan,
  planClasses,
  planEntryCaps,
  planPrograms,
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
import { SyncLog, watermarkForCamp } from "./sync-log.js";

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

export interface RunSyncOptions {
  clubId: string;
  /** Syncs only this camp, bypassing discovery and the backoff check. */
  campId?: string;
  /**
   * Overrides the camp's stored watermark for the registration query, so a backfill re-reads
   * registrations Clubspot last touched before the camp's last successful sync. The schedule pass
   * is unaffected - it's already a full reconcile every run. A successful backfill still records
   * its own `started_at` as the camp's newest `ok` run, same as any other run, so the next normal
   * run's watermark advances from here rather than replaying the backfilled window.
   */
  since?: Date;
  now: Date;
  directus: DirectusClient;
  syncLog: SyncLog;
  personSync: PersonSync;
  gateway: SyncGateway;
}

export interface RunSyncResult {
  runId: string;
  status: "ok" | "failed";
  programsChecked: number;
  programsSynced: number;
  programsSkipped: number;
  programsFailed: number;
  failedCampIds: string[];
}

// All the collections the schedule and registration passes reconcile against, read once per run
// rather than once per camp: fetching each collection's full state once and diffing it against
// every camp avoids a Directus round trip per camp per collection. `people`, `contacts`, and
// `medical_profiles` aren't here: PersonSync reads those with its own bounded, filtered queries
// instead of a full table scan.
interface SharedTables {
  programs: ProgramRow[];
  classes: ClassRow[];
  sessions: SessionRow[];
  sessionClasses: SessionClassRow[];
  entryCaps: EntryCapRow[];
  customFieldDefinitions: CustomFieldDefinitionRow[];
  registrations: RegistrationRow[];
  registrationEntries: RegistrationEntryRow[];
  registrationBilling: RegistrationBillingRow[];
  customFieldResponses: CustomFieldResponseRow[];
}

async function readSharedTables(directus: DirectusClient): Promise<SharedTables> {
  const [
    programs,
    classes,
    sessions,
    sessionClasses,
    entryCaps,
    customFieldDefinitions,
    registrations,
    registrationEntries,
    registrationBilling,
    customFieldResponses,
  ] = await Promise.all([
    directus.readItems<ProgramRow>("programs", { limit: -1 }),
    directus.readItems<ClassRow>("classes", { limit: -1 }),
    directus.readItems<SessionRow>("sessions", { limit: -1 }),
    directus.readItems<SessionClassRow>("session_classes", { limit: -1 }),
    directus.readItems<EntryCapRow>("entry_caps", { limit: -1 }),
    directus.readItems<CustomFieldDefinitionRow>("custom_field_definitions", { limit: -1 }),
    directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
    directus.readItems<RegistrationEntryRow>("registration_entries", { limit: -1 }),
    directus.readItems<RegistrationBillingRow>("registration_billing", { limit: -1 }),
    directus.readItems<CustomFieldResponseRow>("custom_field_responses", { limit: -1 }),
  ]);
  return {
    programs,
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
 * Writes a plan and folds the result back into `existing`, so the next plan in the same camp (or
 * the next camp in the same run) sees it without a re-read.
 */
async function applyPlan<Row extends { id?: string }>(
  directus: DirectusClient,
  collection: string,
  plan: CollectionPlan<Row>,
  existing: Row[],
): Promise<ApplyResult<Row>> {
  const created = plan.toCreate.length > 0 ? await directus.createItems<Row>(collection, plan.toCreate as Row[]) : [];
  // A dry run's createItems returns the input rows with no id (see DirectusClient), but a later
  // stage in the same camp may need one to point a foreign key at - a session at its program, say.
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

interface CampSyncCounts {
  created: number;
  updated: number;
  skipped: number;
}

interface ScheduleSyncResult {
  programId: string;
  classCrmIdByClubspotClassId: Map<string, string>;
  sessionCrmIdByClubspotSessionId: Map<string, string>;
  counts: CampSyncCounts;
}

/**
 * `programs`, `sessions`, `classes`, `session_classes`, `entry_caps` - reconciled in full every
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

  const programPlan = planPrograms([data.camp], tables.programs);
  const programResult = await applyPlan(directus, "programs", programPlan, tables.programs);
  tables.programs = programResult.rows;
  created += programResult.created;
  updated += programResult.updated;
  const programCrmIdByClubspotCampId = indexByClubspotId(tables.programs, "clubspot_camp_id");
  const programId = requireLookup(programCrmIdByClubspotCampId, data.camp.id, "program");

  const sessionPlan = planSessions(data.sessions, programCrmIdByClubspotCampId, tables.sessions);
  const sessionResult = await applyPlan(directus, "sessions", sessionPlan, tables.sessions);
  tables.sessions = sessionResult.rows;
  created += sessionResult.created;
  updated += sessionResult.updated;
  const sessionCrmIdByClubspotSessionId = indexByClubspotId(tables.sessions, "clubspot_session_id");

  const classPlan = planClasses(data.classes, programCrmIdByClubspotCampId, tables.classes);
  const classResult = await applyPlan(directus, "classes", classPlan, tables.classes);
  tables.classes = classResult.rows;
  created += classResult.created;
  updated += classResult.updated;
  const classCrmIdByClubspotClassId = indexByClubspotId(tables.classes, "clubspot_class_id");

  const programClassCrmIds = data.classes.map((campClass) =>
    requireLookup(classCrmIdByClubspotClassId, campClass.id, "class"),
  );
  const sessionClassPlan = planSessionClasses(
    data.sessions,
    sessionCrmIdByClubspotSessionId,
    classCrmIdByClubspotClassId,
    programClassCrmIds,
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
    programId,
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
  programId: string,
  classCrmIdByClubspotClassId: Map<string, string>,
  sessionCrmIdByClubspotSessionId: Map<string, string>,
  tables: SharedTables,
  directus: DirectusClient,
  personSync: PersonSync,
): Promise<CampSyncCounts> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const programCrmIdByClubspotCampId = new Map([[data.camp.id, programId]]);

  const definitionPlan = planCustomFieldDefinitions(
    [data.camp],
    programCrmIdByClubspotCampId,
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
    programCrmIdByClubspotCampId,
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
): Promise<{ programId: string; counts: CampSyncCounts }> {
  const schedule = await syncSchedule(data, tables, directus);
  const registrations = await syncRegistrations(
    data,
    schedule.programId,
    schedule.classCrmIdByClubspotClassId,
    schedule.sessionCrmIdByClubspotSessionId,
    tables,
    directus,
    personSync,
  );

  return {
    programId: schedule.programId,
    counts: {
      created: schedule.counts.created + registrations.created,
      updated: schedule.counts.updated + registrations.updated,
      skipped: schedule.counts.skipped + registrations.skipped,
    },
  };
}

/**
 * One job execution: open the log, discover (or take) the camp(s), sync each one that needs it,
 * and close the log. A camp that throws is recorded as failed and does not stop the others; if
 * something escapes the loop entirely - discovery, the shared-table read, anything - the outer
 * catch below still leaves the log closed instead of stranding the `sync_runs` row at "running".
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { clubId, campId, since, now, directus, syncLog, personSync, gateway } = options;

  const run = await syncLog.startRun(now);
  // A dry run's startRun never reaches Directus (DirectusClient no-ops every write), so `run.id`
  // is never assigned. The program-run rows below still need a value for the required `run_id`.
  const runId = run.id ?? "dry-run";

  let programsChecked = 0;
  let programsSynced = 0;
  let programsSkipped = 0;
  const failedCampIds: string[] = [];
  let runError: string | undefined;

  try {
    const priorRuns = await syncLog.priorProgramRuns();
    const camps = campId ? [await gateway.getCamp(campId)] : await gateway.discoverCamps(clubId);
    programsChecked = camps.length;
    const tables = await readSharedTables(directus);

    for (const camp of camps) {
      const startedAt = new Date();
      const watermark = since ?? watermarkForCamp(camp.id, priorRuns);

      try {
        if (!campId) {
          const { due } = campBackoff(camp.id, priorRuns, now);
          if (!due) {
            await syncLog.recordProgramRun({
              run_id: runId,
              program_id: null,
              clubspot_camp_id: camp.id,
              started_at: startedAt.toISOString(),
              finished_at: new Date().toISOString(),
              status: "skipped",
              items_created: 0,
              items_updated: 0,
              items_skipped: 0,
            });
            programsSkipped++;
            continue;
          }
        }

        // `startedAt`, not `now`, bounds the query: it's the same value this iteration records as
        // the camp's `started_at` below, so the next run's watermark picks up exactly where this
        // window left off. Using `now` here would leave the gap between `now` and `startedAt` -
        // widened by every camp and shared-table read ahead of this one - uncovered by any run.
        const data = await gateway.fetchCampData(camp, watermark, startedAt);
        const { programId, counts } = await syncCamp(data, tables, directus, personSync);

        await syncLog.recordProgramRun({
          run_id: runId,
          program_id: programId,
          clubspot_camp_id: camp.id,
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          status: "ok",
          items_created: counts.created,
          items_updated: counts.updated,
          items_skipped: counts.skipped,
        });
        programsSynced++;
      } catch (error) {
        // Error message/stack are non-enumerable, so log them explicitly - see admin-functions/src/runner.ts:129-134.
        winston.error("Camp sync failed", {
          campId: camp.id,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        });
        failedCampIds.push(camp.id);
        try {
          await syncLog.recordProgramRun({
            run_id: runId,
            program_id: null,
            clubspot_camp_id: camp.id,
            started_at: startedAt.toISOString(),
            finished_at: new Date().toISOString(),
            status: "failed",
            items_created: 0,
            items_updated: 0,
            items_skipped: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (recordError) {
          // A camp already recorded as failed must not also abort the loop: log and move on
          // rather than let this throw escape the way the camp's own error just did.
          winston.error("Recording a camp's program run failed", {
            campId: camp.id,
            error:
              recordError instanceof Error ? { message: recordError.message, stack: recordError.stack } : recordError,
          });
        }
      }
    }
  } catch (error) {
    winston.error("Sync run failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  const status: "ok" | "failed" = runError !== undefined || failedCampIds.length > 0 ? "failed" : "ok";
  const programsFailed = failedCampIds.length;
  const error = runError ?? (failedCampIds.length > 0 ? `Camps failed: ${failedCampIds.join(", ")}` : undefined);

  await syncLog.finishRun(runId, new Date(), {
    status,
    programsChecked,
    programsSynced,
    programsSkipped,
    programsFailed,
    ...(error ? { error } : {}),
  });

  return {
    runId,
    status,
    programsChecked,
    programsSynced,
    programsSkipped,
    programsFailed,
    failedCampIds,
  };
}

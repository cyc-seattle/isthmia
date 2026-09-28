import winston from "winston";
import { Camp, CampClass, CampSession, EntryCap } from "@cyc-seattle/clubspot-sdk";
import { ClassRow, EntryCapRow, SessionClassRow, SessionRow } from "@cyc-seattle/clubspot";
import { CampWithClubspot } from "./schema.js";

/**
 * The schedule pass reconciles `camps`, `sessions`, `classes`, `session_classes`, and
 * `entry_caps` in full on every run, not on a watermark: a class, session, or cap can change
 * without the owning camp's `updatedAt` moving. `packages/admin-functions/src/sessions.ts:56`
 * takes the same approach for the same reason.
 *
 * Creates must happen in this order, since `sessions` and `classes` carry FKs to `camps`, and
 * `session_classes`/`entry_caps` carry FKs to both.
 */
export const SCHEDULE_CREATE_ORDER = ["camps", "sessions", "classes", "session_classes", "entry_caps"] as const;

export interface CollectionPlan<Row extends { id: string }> {
  toCreate: Row[];
  toUpdate: { id: string; patch: Partial<Row> }[];
  /** Rows left out for an unresolvable reference. Undefined means none. */
  skipped?: number;
}

/** The `session_classes`/`custom_field_responses` primary key: their parents' ids, joined. */
export function joinedId(a: string, b: string): string {
  return `${a}:${b}`;
}

// Clubspot dates are UTC (see admin-functions/src/reports.ts), and start_date/end_date are
// Directus `date` columns, so a plain calendar date string is all they hold.
function toDateString(date: Date | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

// These two helpers reach for `Record<string, unknown>` casts because the concrete row
// interfaces (CampRow, SessionRow, ...) have no index signature of their own, and adding one
// to every row type just to satisfy a shared generic isn't worth it for two small helpers.

export function diffFields<Row extends { id?: string }>(existing: Row, desired: Row): Partial<Row> {
  const existingFields = existing as Record<string, unknown>;
  const desiredFields = desired as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(desiredFields)) {
    if (key !== "id" && existingFields[key] !== desiredFields[key]) {
      patch[key] = desiredFields[key];
    }
  }
  return patch as Partial<Row>;
}

/**
 * Diffs `desired` (keyed on `id`, the Clubspot objectId) against `existing`. Pure: a row with no
 * match in `existing` is a create, otherwise it's a field-by-field diff.
 */
export function planById<Row extends { id: string }>(desired: Row[], existing: Row[]): CollectionPlan<Row> {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));

  const toCreate: Row[] = [];
  const toUpdate: { id: string; patch: Partial<Row> }[] = [];

  for (const row of desired) {
    const match = existingById.get(row.id);
    if (!match) {
      toCreate.push(row);
      continue;
    }
    const patch = diffFields(match, row);
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: row.id, patch });
    }
  }

  return { toCreate, toUpdate };
}

/**
 * Reads the code of the camp's Clubspot sales account, or null if it has none set up. Throws
 * rather than writing a silent null if the pointer is present but unfetched (missing `code`) -
 * that means the caller's query forgot `.include("chartOfAccounts")`, not that the camp has no
 * account.
 */
function salesAccountCode(camp: Camp): string | null {
  const chartOfAccounts = camp.get("chartOfAccounts");
  if (!chartOfAccounts) {
    return null;
  }
  const code = chartOfAccounts.get("code");
  if (!code) {
    throw new Error(`Camp ${camp.id}'s chartOfAccounts has no code; was it fetched with .include("chartOfAccounts")?`);
  }
  return code;
}

/**
 * Reconciles `camps` by id, the Clubspot Camp objectId. A new camp is created with fresh backoff
 * state, but an existing row's `synced_through` and `quiet_runs` are never part of the diff: that
 * state is owned by `backoff.ts`'s executor, not this reconcile. Bypasses `planById`, whose
 * generic diff would otherwise patch those fields back to whatever this function desired - here,
 * nothing.
 */
export function planCamps(camps: Camp[], existing: CampWithClubspot[]): CollectionPlan<CampWithClubspot> {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  const toCreate: CampWithClubspot[] = [];
  const toUpdate: { id: string; patch: Partial<CampWithClubspot> }[] = [];

  for (const camp of camps) {
    const desired = {
      id: camp.id,
      name: camp.get("name"),
      start_date: toDateString(camp.get("startDate")),
      end_date: toDateString(camp.get("endDate")),
      archived: camp.get("archived") ?? false,
      clubspot_sales_account: salesAccountCode(camp),
    };
    const match = existingById.get(camp.id);
    if (!match) {
      toCreate.push({ ...desired, synced_through: null, quiet_runs: 0 });
      continue;
    }
    const patch = diffFields<Omit<CampWithClubspot, "synced_through" | "quiet_runs">>(match, desired);
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: camp.id, patch });
    }
  }

  return { toCreate, toUpdate };
}

/**
 * Reconciles `classes` by id. A new class is created unlinked (`program_id: null`); an existing
 * row's `program_id` is never part of the diff, since staff set it by hand, once per class - see
 * #149. Bypasses `planById`, whose generic diff would otherwise patch it back to null on every run.
 */
export function planClasses(campClasses: CampClass[], existing: ClassRow[]): CollectionPlan<ClassRow> {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  const toCreate: ClassRow[] = [];
  const toUpdate: { id: string; patch: Partial<ClassRow> }[] = [];

  for (const campClass of campClasses) {
    const desired = {
      id: campClass.id,
      camp_id: campClass.get("campObject").id,
      name: campClass.get("name"),
    };
    const match = existingById.get(campClass.id);
    if (!match) {
      toCreate.push({ ...desired, program_id: null });
      continue;
    }
    const patch = diffFields<Omit<ClassRow, "program_id">>(match, desired);
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: campClass.id, patch });
    }
  }

  return { toCreate, toUpdate };
}

export function planSessions(campSessions: CampSession[], existing: SessionRow[]): CollectionPlan<SessionRow> {
  const desired = campSessions.map((session) => {
    const startDate = toDateString(session.get("startDate"));
    const endDate = toDateString(session.get("endDate"));
    if (startDate === null || endDate === null) {
      winston.warn(`Clubspot session ${session.id} is missing a start or end date; writing null`, {
        clubspotSessionId: session.id,
      });
    }
    // Some legacy sessions predate the name field; the SDK types it required, but Clubspot sends
    // none for those.
    const name = session.get("name") ?? null;
    return {
      id: session.id,
      camp_id: session.get("campObject").id,
      name,
      start_date: startDate,
      end_date: endDate,
      archived: session.get("archived") ?? false,
    };
  });
  return planById(desired, existing);
}

/**
 * `class_id` is written as-is, trusting Postgres to reject a class this camp's own sync just
 * created or already knows - but `session_id` is checked against `knownSessionIds` first: unlike
 * a class, a session can be genuinely deleted in Clubspot (not merely archived) with nothing left
 * to resolve against, and a skipped cap is better than losing the whole batch to one bad FK.
 */
export function planEntryCaps(
  entryCaps: EntryCap[],
  knownSessionIds: ReadonlySet<string>,
  existing: EntryCapRow[],
): CollectionPlan<EntryCapRow> {
  let skipped = 0;
  const desired = entryCaps.flatMap((cap) => {
    const sessionObject = cap.get("campSessionObject");
    let sessionId: string | null = null;
    if (sessionObject) {
      if (!knownSessionIds.has(sessionObject.id)) {
        winston.warn(`Entry cap ${cap.id} references unresolved Clubspot session ${sessionObject.id}; skipping`, {
          clubspotEntryCapId: cap.id,
          clubspotSessionId: sessionObject.id,
        });
        skipped++;
        return [];
      }
      sessionId = sessionObject.id;
    }
    return [{ id: cap.id, class_id: cap.get("campClassObject").id, session_id: sessionId, cap: cap.get("cap") }];
  });
  return { ...planById(desired, existing), skipped };
}

export interface SessionClassPlan {
  toCreate: SessionClassRow[];
  /** Existing rows to unlink: the class is no longer offered by that session. */
  toRemove: SessionClassRow[];
}

/**
 * Reconciles `session_classes` by membership rather than by key: the join has no Clubspot id of
 * its own, so its `id` is `session_id` and `class_id` joined (`joinedId`). A session with no
 * explicit `campClassesArray` offers every class in the camp (Clubspot's `allClasses`), expanded
 * here into one row per class.
 */
export function planSessionClasses(
  campSessions: CampSession[],
  campClassIds: readonly string[],
  existing: SessionClassRow[],
): SessionClassPlan {
  const toCreate: SessionClassRow[] = [];
  const toRemove: SessionClassRow[] = [];

  for (const session of campSessions) {
    const sessionId = session.id;
    const explicitClasses = session.get("campClassesArray");
    const desiredClassIds = new Set(explicitClasses ? explicitClasses.map((campClass) => campClass.id) : campClassIds);

    const existingForSession = existing.filter((row) => row.session_id === sessionId);
    const existingClassIds = new Set(existingForSession.map((row) => row.class_id));

    for (const classId of desiredClassIds) {
      if (!existingClassIds.has(classId)) {
        toCreate.push({ id: joinedId(sessionId, classId), session_id: sessionId, class_id: classId });
      }
    }
    for (const row of existingForSession) {
      if (!desiredClassIds.has(row.class_id)) {
        toRemove.push(row);
      }
    }
  }

  return { toCreate, toRemove };
}

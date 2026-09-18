import winston from "winston";
import { Camp, CampClass, CampSession, EntryCap } from "@cyc-seattle/clubspot-sdk";
import { ClassRow, EntryCapRow, ProgramRow, SessionClassRow, SessionRow } from "@cyc-seattle/crm";

/**
 * The schedule pass reconciles `programs`, `sessions`, `classes`, `session_classes`, and
 * `entry_caps` in full on every run, not on a watermark: a class, session, or cap can change
 * without the owning camp's `updatedAt` moving. `packages/admin-functions/src/sessions.ts:56`
 * takes the same approach for the same reason.
 *
 * Creates must happen in this order, since `sessions` and `classes` carry FKs to `programs`, and
 * `session_classes`/`entry_caps` carry FKs to both.
 */
export const SCHEDULE_CREATE_ORDER = ["programs", "sessions", "classes", "session_classes", "entry_caps"] as const;

export interface CollectionPlan<Row> {
  toCreate: Omit<Row, "id">[];
  toUpdate: { id: string; patch: Partial<Row> }[];
}

// Exported for reuse by registrations.ts, which reconciles by key the same way.
export function requireLookup(map: ReadonlyMap<string, string>, clubspotId: string, kind: string): string {
  const crmId = map.get(clubspotId);
  if (!crmId) {
    throw new Error(`No CRM ${kind} row for Clubspot id ${clubspotId}; sync ${kind}s before this collection`);
  }
  return crmId;
}

// Clubspot dates are UTC (see admin-functions/src/reports.ts), and start_date/end_date are
// Directus `date` columns, so a plain calendar date string is all they hold.
function toDateString(date: Date | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

interface DesiredRow<Row> {
  key: string;
  row: Omit<Row, "id">;
}

// These two helpers reach for `Record<string, unknown>` casts because the concrete row
// interfaces (ProgramRow, SessionRow, ...) have no index signature of their own, and adding one
// to every row type just to satisfy a shared generic isn't worth it for two small helpers.

export function diffFields<Row extends { id?: string }>(existing: Row, desired: Omit<Row, "id">): Partial<Row> {
  const existingFields = existing as Record<string, unknown>;
  const desiredFields = desired as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(desiredFields)) {
    if (existingFields[key] !== desiredFields[key]) {
      patch[key] = desiredFields[key];
    }
  }
  return patch as Partial<Row>;
}

/** Keys `existing` by `keyField`, then diffs each desired row against its match. Pure. */
export function planByKey<Row extends { id?: string }>(
  desired: DesiredRow<Row>[],
  existing: Row[],
  keyField: keyof Row,
): CollectionPlan<Row> {
  const existingByKey = new Map<string, Row>();
  for (const row of existing) {
    const key = (row as Record<string, unknown>)[keyField as string];
    if (typeof key === "string") {
      existingByKey.set(key, row);
    }
  }

  const toCreate: Omit<Row, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<Row> }[] = [];

  for (const { key, row } of desired) {
    const match = existingByKey.get(key);
    if (!match?.id) {
      toCreate.push(row);
      continue;
    }
    const patch = diffFields(match, row);
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: match.id, patch });
    }
  }

  return { toCreate, toUpdate };
}

export function planPrograms(camps: Camp[], existing: ProgramRow[]): CollectionPlan<ProgramRow> {
  const desired = camps.map((camp) => ({
    key: camp.id,
    row: { name: camp.get("name"), clubspot_camp_id: camp.id },
  }));
  return planByKey(desired, existing, "clubspot_camp_id");
}

export function planClasses(
  campClasses: CampClass[],
  programCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  existing: ClassRow[],
): CollectionPlan<ClassRow> {
  const desired = campClasses.map((campClass) => ({
    key: campClass.id,
    row: {
      program_id: requireLookup(programCrmIdByClubspotCampId, campClass.get("campObject").id, "program"),
      name: campClass.get("name"),
      clubspot_class_id: campClass.id,
    },
  }));
  return planByKey(desired, existing, "clubspot_class_id");
}

export function planSessions(
  campSessions: CampSession[],
  programCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  existing: SessionRow[],
): CollectionPlan<SessionRow> {
  const desired = campSessions.map((session) => {
    const startDate = toDateString(session.get("startDate"));
    const endDate = toDateString(session.get("endDate"));
    if (startDate === null || endDate === null) {
      winston.warn(`Clubspot session ${session.id} is missing a start or end date; writing null`, {
        clubspotSessionId: session.id,
      });
    }
    return {
      key: session.id,
      row: {
        program_id: requireLookup(programCrmIdByClubspotCampId, session.get("campObject").id, "program"),
        name: session.get("name"),
        start_date: startDate,
        end_date: endDate,
        clubspot_session_id: session.id,
        archived: session.get("archived") ?? false,
      },
    };
  });
  return planByKey(desired, existing, "clubspot_session_id");
}

export function planEntryCaps(
  entryCaps: EntryCap[],
  classCrmIdByClubspotClassId: ReadonlyMap<string, string>,
  sessionCrmIdByClubspotSessionId: ReadonlyMap<string, string>,
  existing: EntryCapRow[],
): CollectionPlan<EntryCapRow> {
  const desired = entryCaps.flatMap((cap) => {
    const classId = requireLookup(classCrmIdByClubspotClassId, cap.get("campClassObject").id, "class");
    const sessionObject = cap.get("campSessionObject");
    let sessionId: string | null = null;
    if (sessionObject) {
      sessionId = sessionCrmIdByClubspotSessionId.get(sessionObject.id) ?? null;
      if (sessionId === null) {
        // Archived or deleted in Clubspot, with nothing left to resolve against - see the design
        // doc's Class B. Skipping (rather than writing null, which means "applies to every
        // session") leaves this cap unrepresented until the session is backfilled.
        winston.warn(`Entry cap ${cap.id} references unresolved Clubspot session ${sessionObject.id}; skipping`, {
          clubspotEntryCapId: cap.id,
          clubspotSessionId: sessionObject.id,
        });
        return [];
      }
    }
    return [
      {
        key: cap.id,
        row: {
          class_id: classId,
          session_id: sessionId,
          cap: cap.get("cap"),
          clubspot_entry_cap_id: cap.id,
        },
      },
    ];
  });
  return planByKey(desired, existing, "clubspot_entry_cap_id");
}

export interface SessionClassPlan {
  toCreate: Omit<SessionClassRow, "id">[];
  /** Existing rows to unlink: the class is no longer offered by that session. */
  toRemove: SessionClassRow[];
}

/**
 * Reconciles `session_classes` by membership rather than by key: the join has no Clubspot id of
 * its own. A session with no explicit `campClassesArray` offers every class in the program
 * (Clubspot's `allClasses`), expanded here into one row per class.
 */
export function planSessionClasses(
  campSessions: CampSession[],
  sessionCrmIdByClubspotSessionId: ReadonlyMap<string, string>,
  classCrmIdByClubspotClassId: ReadonlyMap<string, string>,
  programClassCrmIds: readonly string[],
  existing: SessionClassRow[],
): SessionClassPlan {
  const toCreate: Omit<SessionClassRow, "id">[] = [];
  const toRemove: SessionClassRow[] = [];

  for (const session of campSessions) {
    const sessionId = requireLookup(sessionCrmIdByClubspotSessionId, session.id, "session");
    const explicitClasses = session.get("campClassesArray");
    const desiredClassIds = new Set(
      explicitClasses
        ? explicitClasses.map((campClass) => requireLookup(classCrmIdByClubspotClassId, campClass.id, "class"))
        : programClassCrmIds,
    );

    const existingForSession = existing.filter((row) => row.session_id === sessionId);
    const existingClassIds = new Set(existingForSession.map((row) => row.class_id));

    for (const classId of desiredClassIds) {
      if (!existingClassIds.has(classId)) {
        toCreate.push({ session_id: sessionId, class_id: classId });
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

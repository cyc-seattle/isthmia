import winston from "winston";
import { Camp, CampClass, CampSession, EntryCap } from "@cyc-seattle/clubspot-sdk";
import { SessionClassRow } from "@cyc-seattle/crm";
import { ClassWithClubspot, EntryCapWithClubspot, OfferingWithClubspot, SessionWithClubspot } from "./schema.js";

/**
 * The schedule pass reconciles `offerings`, `sessions`, `classes`, `session_classes`, and
 * `entry_caps` in full on every run, not on a watermark: a class, session, or cap can change
 * without the owning camp's `updatedAt` moving. `packages/admin-functions/src/sessions.ts:56`
 * takes the same approach for the same reason.
 *
 * Creates must happen in this order, since `sessions` and `classes` carry FKs to `offerings`, and
 * `session_classes`/`entry_caps` carry FKs to both.
 */
export const SCHEDULE_CREATE_ORDER = ["offerings", "sessions", "classes", "session_classes", "entry_caps"] as const;

export interface CollectionPlan<Row> {
  toCreate: Omit<Row, "id">[];
  toUpdate: { id: string; patch: Partial<Row> }[];
  /** Rows left out for an unresolvable reference. Undefined means none. */
  skipped?: number;
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
// interfaces (OfferingRow, SessionRow, ...) have no index signature of their own, and adding one
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

/**
 * Reconciles `offerings` by `clubspot_camp_id`, the Clubspot-Camp-level row. A new offering is
 * created unlinked (`program_id: null`) with fresh backoff state, but an existing row's
 * `program_id`, `synced_through`, and `quiet_runs` are never part of the diff: the program link is
 * set by hand, once per offering, and the backoff state is owned by `backoff.ts`'s executor, not
 * this reconcile. Bypasses `planByKey`, whose generic diff would otherwise patch those fields back
 * to whatever this function desired - here, nothing.
 */
export function planOfferings(camps: Camp[], existing: OfferingWithClubspot[]): CollectionPlan<OfferingWithClubspot> {
  const existingByClubspotCampId = new Map(existing.map((row) => [row.clubspot_camp_id, row] as const));
  const toCreate: Omit<OfferingWithClubspot, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<OfferingWithClubspot> }[] = [];

  for (const camp of camps) {
    const desired = {
      name: camp.get("name"),
      clubspot_camp_id: camp.id,
      start_date: toDateString(camp.get("startDate")),
      end_date: toDateString(camp.get("endDate")),
    };
    const match = existingByClubspotCampId.get(camp.id);
    if (!match?.id) {
      toCreate.push({ ...desired, program_id: null, synced_through: null, quiet_runs: 0 });
      continue;
    }
    const patch = diffFields<Omit<OfferingWithClubspot, "program_id" | "synced_through" | "quiet_runs">>(
      match,
      desired,
    );
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: match.id, patch });
    }
  }

  return { toCreate, toUpdate };
}

export function planClasses(
  campClasses: CampClass[],
  offeringCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  existing: ClassWithClubspot[],
): CollectionPlan<ClassWithClubspot> {
  const desired = campClasses.map((campClass) => ({
    key: campClass.id,
    row: {
      offering_id: requireLookup(offeringCrmIdByClubspotCampId, campClass.get("campObject").id, "offering"),
      name: campClass.get("name"),
      clubspot_class_id: campClass.id,
    },
  }));
  return planByKey(desired, existing, "clubspot_class_id");
}

export function planSessions(
  campSessions: CampSession[],
  offeringCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  existing: SessionWithClubspot[],
): CollectionPlan<SessionWithClubspot> {
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
      key: session.id,
      row: {
        offering_id: requireLookup(offeringCrmIdByClubspotCampId, session.get("campObject").id, "offering"),
        name,
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
  existing: EntryCapWithClubspot[],
): CollectionPlan<EntryCapWithClubspot> {
  let skipped = 0;
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
        skipped++;
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
  return { ...planByKey(desired, existing, "clubspot_entry_cap_id"), skipped };
}

export interface SessionClassPlan {
  toCreate: Omit<SessionClassRow, "id">[];
  /** Existing rows to unlink: the class is no longer offered by that session. */
  toRemove: SessionClassRow[];
}

/**
 * Reconciles `session_classes` by membership rather than by key: the join has no Clubspot id of
 * its own. A session with no explicit `campClassesArray` offers every class in the offering
 * (Clubspot's `allClasses`), expanded here into one row per class.
 */
export function planSessionClasses(
  campSessions: CampSession[],
  sessionCrmIdByClubspotSessionId: ReadonlyMap<string, string>,
  classCrmIdByClubspotClassId: ReadonlyMap<string, string>,
  offeringClassCrmIds: readonly string[],
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
        : offeringClassCrmIds,
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

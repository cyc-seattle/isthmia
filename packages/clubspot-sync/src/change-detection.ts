import {
  Camp,
  CampClass,
  CampSession,
  LoggedQuery,
  Registration,
  RegistrationCampSession,
} from "@cyc-seattle/clubspot-sdk";

/**
 * Counts of child rows changed since a watermark, one per class whose changes don't move the
 * camp's own `updatedAt`.
 */
export interface ChildCounts {
  campSessions: number;
  campClasses: number;
  registrations: number;
  registrationCampSessions: number;
}

/** The Parse side of change detection: one `count()` per child class, filtered on `updatedAt`. */
export async function countChildChanges(camp: Camp, watermark: Date): Promise<ChildCounts> {
  const [campSessions, campClasses, registrations, registrationCampSessions] = await Promise.all([
    new LoggedQuery(CampSession).equalTo("campObject", camp).greaterThanOrEqualTo("updatedAt", watermark).count(),
    new LoggedQuery(CampClass).equalTo("campObject", camp).greaterThanOrEqualTo("updatedAt", watermark).count(),
    new LoggedQuery(Registration).equalTo("campObject", camp).greaterThanOrEqualTo("updatedAt", watermark).count(),
    new LoggedQuery(RegistrationCampSession)
      .equalTo("campObject", camp)
      .greaterThanOrEqualTo("updatedAt", watermark)
      .count(),
  ]);
  return { campSessions, campClasses, registrations, registrationCampSessions };
}

// EntryCap has no pointer to a camp, so a capacity-only change is invisible to the counts above,
// and nothing in `updatedAt` reveals a delete. A camp whose last successful sync is older than
// this is synced regardless of the counts - a refresh floor, not a snooze.
export const REFRESH_FLOOR_MS = 24 * 60 * 60 * 1000;

export interface CampChangeInput {
  campId: string;
  campUpdatedAt: Date;
  childCounts: ChildCounts;
  /** This camp's watermark: the greatest `started_at` of its `ok` sync_program_runs rows, or the epoch. */
  watermark: Date;
  now: Date;
}

/**
 * Decides whether a camp needs syncing. Pure: no Parse queries, no Directus reads, no clock reads.
 */
export function needsSync(input: CampChangeInput): boolean {
  const { childCounts, campUpdatedAt, watermark, now } = input;

  if (now.getTime() - watermark.getTime() > REFRESH_FLOOR_MS) {
    return true;
  }
  if (Object.values(childCounts).some((count) => count > 0)) {
    return true;
  }
  return campUpdatedAt >= watermark;
}

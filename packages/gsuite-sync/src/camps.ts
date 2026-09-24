import { CampRow } from "@cyc-seattle/clubspot";

/**
 * How far back a camp's `end_date` can fall and still contribute participants to its program's
 * group (#149). ~12 months, so a just-finished season's roster stays in place until the next one
 * begins, rather than the group emptying out between seasons.
 */
const MEMBERSHIP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Whether a camp is still within the membership window: running, upcoming, or ended recently
 * enough (see `MEMBERSHIP_WINDOW_MS`). Governs which classes contribute participants to a
 * program's group in `planProgramMembers` - it does not gate whether the program's task gets
 * enqueued at all (see `enqueueDueProgramGroups`), and it plays no part in a person already added
 * ever being removed (add-only).
 */
export function isCampInMembershipWindow(camp: Pick<CampRow, "end_date">, now: Date): boolean {
  if (camp.end_date == null) {
    return true;
  }
  return new Date(camp.end_date).getTime() >= now.getTime() - MEMBERSHIP_WINDOW_MS;
}

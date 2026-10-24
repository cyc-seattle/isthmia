import { CampRow } from "@cyc-seattle/clubspot";

/**
 * Whether a camp is current or upcoming: not archived, and its `end_date` hasn't passed. A null
 * `end_date` counts. Governs which classes contribute participants to a program's group in
 * `planProgramMembers`, not whether the program's task is enqueued (#265).
 */
export function isCampActive(camp: Pick<CampRow, "end_date" | "archived">, now: Date): boolean {
  if (camp.archived) {
    return false;
  }
  return camp.end_date == null || new Date(camp.end_date).getTime() >= now.getTime();
}

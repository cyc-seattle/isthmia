import { CampRow } from "@cyc-seattle/clubspot";

const pacificDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });

/**
 * Whether a camp is current or upcoming: not archived, and its `end_date` hasn't passed. A null
 * `end_date` counts. Governs which classes contribute participants to a program's group in
 * `planProgramMembers`, not whether the program's task is enqueued (#265).
 */
export function isCampActive(camp: Pick<CampRow, "end_date" | "archived">, now: Date): boolean {
  if (camp.archived) {
    return false;
  }
  // `end_date` is a Directus date ("YYYY-MM-DD"), so a camp counts through the whole of its last day in Seattle.
  return camp.end_date == null || camp.end_date.slice(0, 10) >= pacificDate.format(now);
}

import { CampRow } from "@cyc-seattle/clubspot";

/**
 * Whether a camp is running right now: `start_date <= now <= end_date`, matching the design's
 * "Active camp" Directus rule exactly, so the family pass grants the same roster access the
 * permission rules will read. Unlike `gsuite-sync`'s membership window, there's no trailing grace
 * period and no "next season" rule - a null date fails, the same as a null date of birth fails
 * `_lte` in Directus, so a camp missing either date simply doesn't count as active.
 */
export function isCampActive(camp: Pick<CampRow, "start_date" | "end_date">, now: Date): boolean {
  if (camp.start_date == null || camp.end_date == null) {
    return false;
  }
  const start = new Date(camp.start_date).getTime();
  const end = new Date(camp.end_date).getTime();
  const time = now.getTime();
  return start <= time && time <= end;
}

import { CampRow } from "@cyc-seattle/clubspot";

/**
 * Whether a camp is current or still upcoming: its `end_date` is unset or hasn't passed yet.
 * This is the "current camp forward" scope the membership seed uses - a program can have years
 * of past camps, and only the live one (and whatever's next) should feed the group's task
 * queue. Nothing already in a group is ever removed, so a camp aging out of this filter has no
 * effect on membership it already granted.
 */
export function isCurrentOrFutureCamp(camp: Pick<CampRow, "end_date">, now: Date): boolean {
  return camp.end_date == null || new Date(camp.end_date) >= now;
}

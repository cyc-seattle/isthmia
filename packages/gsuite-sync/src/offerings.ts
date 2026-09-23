import { OfferingRow } from "@cyc-seattle/crm";

/**
 * Whether an offering is current or still upcoming: its `end_date` is unset or hasn't passed yet.
 * This is the "current offering forward" scope the membership seed uses - a program can have years
 * of past offerings, and only the live one (and whatever's next) should feed the group's task
 * queue. Nothing already in a group is ever removed, so an offering aging out of this filter has no
 * effect on membership it already granted.
 */
export function isCurrentOrFutureOffering(offering: Pick<OfferingRow, "end_date">, now: Date): boolean {
  return offering.end_date == null || new Date(offering.end_date) >= now;
}

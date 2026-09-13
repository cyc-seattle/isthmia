import { Camp, Club, LoggedQuery } from "@cyc-seattle/clubspot-sdk";

/**
 * Lists every non-archived camp for a club - the set of camps the sync considers each run.
 * Matches the query in admin-functions/src/camps.ts:37.
 */
export async function discoverCamps(clubId: string): Promise<Camp[]> {
  const club = await new LoggedQuery(Club).get(clubId);

  return new LoggedQuery(Camp).equalTo("clubObject", club).equalTo("archived", false).addDescending("startDate").find();
}

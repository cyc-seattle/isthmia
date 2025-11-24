import Parse from "parse/node.js";

interface RetrieveGolfAvailabilityRequest {
  clubId: string;
  courseIds: string[];
  date: Date;
}

export async function retrieveGolfAvailability(
  request: RetrieveGolfAvailabilityRequest,
): Promise<object> {
  // TODO: Specify the response interface
  return Parse.Cloud.run("retrieve_golf_availability", {
    club_id: request.clubId,
    course_ids: request.courseIds,
    date_string: request.date.toDateString(),
    // TODO: do we need these?
    day: 1,
    include_billing: false,
    party_size: 1,
  });
}

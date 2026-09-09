import Parse from "parse/node.js";

interface RetrieveGolfAvailabilityRequest {
  clubId: string;
  courseIds: string[];
  date: Date;
}

export async function retrieveGolfAvailability(request: RetrieveGolfAvailabilityRequest): Promise<object> {
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

interface RetrieveCalendarEventsRequest {
  clubId: string;
  startTimestamp: number;
  endTimestamp: number;
  isAdmin?: boolean;
}

interface CalendarEvent {
  id: string;
  title: string;
  ts: number;
  end_ts: number;
  isAllDay: boolean;
  type: string;
  filter_id: string;
  event_tag_ids: string[];
  bgColors: string[];
  reservation_id: string;
}

function retrieveEventsForCalendar(
  cloudFunction: string,
  request: RetrieveCalendarEventsRequest,
): Promise<CalendarEvent[]> {
  return Parse.Cloud.run(cloudFunction, {
    club_id: request.clubId,
    start_timestamp: request.startTimestamp,
    end_timestamp: request.endTimestamp,
    is_admin: request.isAdmin ?? true,
  });
}

/** Mirrors the Events->Calendar page of the dashboard: a lightweight feed of camps in a date range. */
export const retrieveCampsForCalendar = (request: RetrieveCalendarEventsRequest) =>
  retrieveEventsForCalendar("retrieve_camps_for_calendar_v2", request);

/** Mirrors the Events->Calendar page of the dashboard: a lightweight feed of regattas in a date range. */
export const retrieveRegattasForCalendar = (request: RetrieveCalendarEventsRequest) =>
  retrieveEventsForCalendar("retrieve_regattas_for_calendar_v2", request);

/** Mirrors the Events->Calendar page of the dashboard: a lightweight feed of social events in a date range. */
export const retrieveSocialEventsForCalendar = (request: RetrieveCalendarEventsRequest) =>
  retrieveEventsForCalendar("retrieve_social_events_for_calendar_v2", request);

/** Mirrors the Events->Calendar page of the dashboard: a lightweight feed of banquets in a date range. */
export const retrieveBanquetsForCalendar = (request: RetrieveCalendarEventsRequest) =>
  retrieveEventsForCalendar("retrieve_banquets_for_calendar_v2", request);

/** Mirrors the Events->Calendar page of the dashboard: a lightweight feed of group classes in a date range. */
export const retrieveGroupClassesForCalendar = (request: RetrieveCalendarEventsRequest) =>
  retrieveEventsForCalendar("retrieve_group_classes_for_calendar_v2", request);

interface RetrieveSentCampaignsRequest {
  clubId: string;
  search?: string;
  skip?: number;
  limit?: number;
  status?: "sent" | "draft" | "scheduled" | string;
  transactional?: boolean;
}

interface SentCampaign {
  objectId: string;
  event_timestamp: { iso: string };
  // TODO: Specify the rest of the campaign summary shape (subject, recipient list, etc.) once needed -
  // the response also includes a `mdb_search` array of every recipient's name/email (PII).
  [key: string]: unknown;
}

/** Mirrors the Communication->Sent page of the dashboard. */
export function retrieveSentCampaigns(request: RetrieveSentCampaignsRequest): Promise<{ results: SentCampaign[] }> {
  return Parse.Cloud.run("retrieve_sent_campaigns", {
    club_id: request.clubId,
    search: request.search ?? "",
    skip: request.skip ?? 0,
    limit: request.limit ?? 25,
    status: request.status ?? "sent",
    transactional: request.transactional ?? false,
  });
}

interface MessageStats {
  _id: string; // the ses_campaigns objectId
  open_count: number;
  bounce_count: number;
  recipient_count: number;
}

/** Open/bounce/recipient counts for a set of sent campaigns, keyed by ses_campaigns objectId. */
export function retrieveMessageStats(clubId: string, sesCampaignIds: string[]): Promise<MessageStats[]> {
  return Parse.Cloud.run("retrieve_message_stats", {
    club_id: clubId,
    ses_campaign_ids: sesCampaignIds,
  });
}

interface GetLineItemsForChannelSummaryRequest {
  clubId: string;
  startTimestamp: number;
  endTimestamp: number;
  channelIds?: string[];
  productIds?: string[];
  utcOffset?: string;
  comparisonRange?: "day" | "week" | "month" | "year" | string;
  includeServiceChargeInNet?: boolean;
}

interface ChannelSummaryDatum {
  _id: string | null | { year: string; month: string; day: string };
  line_count: number;
  order_count: number;
  gross_volume: number;
  net_volume: number;
  gross: number;
  net: number;
  tax: number;
  discount: number;
  reversals: number;
  tip: number;
  default_gratuity: number;
  cash: number;
  check: number;
  card: number;
  house_account: number;
  other: number;
}

interface ChannelSummaryPeriod {
  summary_data: ChannelSummaryDatum[];
  chart_data: ChannelSummaryDatum[];
}

interface GetLineItemsForChannelSummaryResponse {
  primary_data: ChannelSummaryPeriod;
  comparison_data: ChannelSummaryPeriod & {
    startTimestamp: number;
    endTimestamp: number;
    offset_from_primary_period: number;
  };
}

/**
 * Revenue broken down by channel (registration, point of sale, membership, etc.) over a date
 * range, with a same-length comparison period. Mirrors Reporting->Channel summary.
 */
export function getLineItemsForChannelSummary(
  request: GetLineItemsForChannelSummaryRequest,
): Promise<GetLineItemsForChannelSummaryResponse> {
  return Parse.Cloud.run("get_line_items_for_channel_summary", {
    club_id: request.clubId,
    startTimestamp: request.startTimestamp,
    endTimestamp: request.endTimestamp,
    channel_ids: request.channelIds ?? [],
    product_ids: request.productIds ?? [],
    utc_offset: request.utcOffset ?? "UTC",
    reportingHoursRange: {},
    xAxisUnit: "day",
    comparison_range: request.comparisonRange ?? "month",
    include_service_charge_in_net: request.includeServiceChargeInNet ?? true,
  });
}

/** Running total of manually-entered expenses over a date range. Mirrors Reporting->Expenses. */
export function getExpensesRunningTotal(clubId: string, startDate: Date, endDate: Date): Promise<{ total: number }> {
  return Parse.Cloud.run("getExpensesRunningTotal", {
    clubId,
    startDate,
    endDate,
  });
}

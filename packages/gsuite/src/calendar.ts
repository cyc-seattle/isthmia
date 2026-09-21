import { calendar_v3, google } from "googleapis";
import { Auth } from "googleapis";
import { safeCall } from "./common.js";
import { DateTime } from "luxon";
import winston from "winston";

/**
 * Represents a calendar event
 */
export interface CalendarEvent {
  /** Unique identifier for the event */
  id: string;
  title: string;
  startTime: DateTime;
  endTime: DateTime;
  allDay: boolean;
  description?: string;
  location?: string;
  /** Additional metadata */
  metadata?: Record<string, string> | undefined;
}

/**
 * Google Calendar API client
 */
export class CalendarClient {
  private client: calendar_v3.Calendar;

  constructor(auth: Auth.GoogleAuth) {
    this.client = google.calendar({ version: "v3", auth } as any);
  }

  public loadCalendar(calendarId: string): Calendar {
    return new Calendar(this.client, calendarId);
  }
}

export class Calendar {
  constructor(
    private client: calendar_v3.Calendar,
    public readonly calendarId: string,
  ) {}

  /**
   * Gets a single event by ID
   * Returns null if the event doesn't exist
   */
  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    winston.debug("Getting calendar event", { calendar: this.calendarId, eventId });

    try {
      const response = await safeCall<{ data: calendar_v3.Schema$Event }>(async () =>
        this.client.events.get({
          calendarId: this.calendarId,
          eventId,
        }),
      );

      if (!response.data.id || response.data.status === "cancelled") {
        return null;
      }

      winston.debug("Found calendar event", { eventId: response.data.id });
      return convertToCalendarEvent(response.data);
    } catch (error: any) {
      // If event doesn't exist, return null instead of throwing
      if (error.code === 404) {
        winston.debug("Event not found", { eventId });
        return null;
      }
      throw error;
    }
  }

  /**
   * Lists all events in a calendar within a date range
   */
  async listEvents(timeMin?: DateTime, timeMax?: DateTime): Promise<CalendarEvent[]> {
    winston.debug("Listing calendar events", { calendar: this.calendarId, timeMin, timeMax });

    // Typed explicitly, and the optional bounds assigned only when present: given a bare object
    // literal TypeScript resolves `events.list` to its callback-style overload and infers `void`,
    // and under exactOptionalPropertyTypes an explicit `undefined` is not assignable to `timeMin?`.
    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId: this.calendarId,
      singleEvents: true,
      orderBy: "startTime",
    };
    const min = timeMin?.toISO();
    if (min) {
      params.timeMin = min;
    }
    const max = timeMax?.toISO();
    if (max) {
      params.timeMax = max;
    }
    const data = await safeCall<calendar_v3.Schema$Events>(async () => {
      const res = await this.client.events.list(params);
      return res.data;
    });

    const events = data.items ?? [];
    winston.info(`Found ${events.length} events in calendar`);

    return events
      .filter((event: any) => Boolean(event.start && event.id))
      .map((event: any) => convertToCalendarEvent(event));
  }

  /**
   * Creates a new event in the calendar
   */
  async createEvent(calendarId: string, event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    winston.debug("Creating calendar event", { calendar: this.calendarId, event });

    const response = await safeCall<{ data: calendar_v3.Schema$Event }>(async () =>
      this.client.events.insert({
        calendarId,
        requestBody: convertToGoogleEvent(event),
      }),
    );

    if (!response.data.id) {
      throw new Error("Failed to create event: no ID returned");
    }

    winston.info("Created calendar event", { eventId: response.data.id });
    return convertToCalendarEvent(response.data);
  }

  /**
   * Updates an existing event in the calendar
   */
  async updateEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent> {
    winston.debug("Updating calendar event", { calendar: calendarId, eventId: event.id });

    const response = await safeCall<{ data: calendar_v3.Schema$Event }>(async () =>
      this.client.events.update({
        calendarId,
        eventId: event.id,
        requestBody: convertToGoogleEvent(event),
      }),
    );

    if (!response.data.id) {
      throw new Error("Failed to update event: no ID returned");
    }

    winston.info("Updated calendar event", { eventId: response.data.id });
    return convertToCalendarEvent(response.data);
  }
}

function convertToCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  const allDay = !event.start?.dateTime;
  const startTime = allDay ? DateTime.fromISO(event.start?.date ?? "") : DateTime.fromISO(event.start?.dateTime ?? "");
  const endTime = allDay ? DateTime.fromISO(event.end?.date ?? "") : DateTime.fromISO(event.end?.dateTime ?? "");

  const calEvent: CalendarEvent = {
    id: event.id!,
    title: event.summary ?? "Untitled Event",
    startTime,
    endTime,
    allDay,
  };

  if (event.description) {
    calEvent.description = event.description;
  }
  if (event.location) {
    calEvent.location = event.location;
  }
  if (event.extendedProperties?.private) {
    calEvent.metadata = event.extendedProperties.private as Record<string, string>;
  }

  return calEvent;
}

function convertToGoogleEvent(event: Partial<CalendarEvent>): calendar_v3.Schema$Event {
  const googleEvent: calendar_v3.Schema$Event = {
    summary: event.title ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
  };

  if (event.startTime && event.endTime) {
    if (event.allDay) {
      googleEvent.start = { date: event.startTime.toISODate() ?? null };
      googleEvent.end = { date: event.endTime.toISODate() ?? null };
    } else {
      googleEvent.start = { dateTime: event.startTime.toISO() ?? null };
      googleEvent.end = { dateTime: event.endTime.toISO() ?? null };
    }
  }

  if (event.metadata) {
    googleEvent.extendedProperties = {
      private: event.metadata,
    };
  }

  return googleEvent;
}

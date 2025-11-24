import { calendar_v3, google } from "googleapis";
import { Auth } from "googleapis";
import { DateTime } from "luxon";
import winston from "winston";

/**
 * Represents a calendar event
 */
export interface CalendarEvent {
  /** Unique identifier for the event */
  id: string;
  /** Event title/summary */
  title: string;
  /** Event start date/time */
  startTime: DateTime;
  /** Event end date/time */
  endTime: DateTime;
  /** Whether this is an all-day event */
  allDay: boolean;
  /** Event description */
  description?: string | undefined;
  /** Event location */
  location?: string | undefined;
  /** Additional metadata */
  metadata?: Record<string, string> | undefined;
}

/**
 * Google Calendar API client
 */
export class CalendarClient {
  private calendar: calendar_v3.Calendar;

  constructor(auth: Auth.GoogleAuth) {
    this.calendar = google.calendar({ version: "v3", auth } as any);
  }

  /**
   * Lists all events in a calendar within a date range
   */
  async listEvents(calendarId: string, timeMin?: DateTime, timeMax?: DateTime): Promise<CalendarEvent[]> {
    winston.debug("Listing calendar events", { calendarId, timeMin, timeMax });

    const response: any = await this.calendar.events.list({
      calendarId,
      timeMin: timeMin?.toISO() ?? undefined,
      timeMax: timeMax?.toISO() ?? undefined,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response?.data?.items ?? [];
    winston.info(`Found ${events.length} events in calendar`);

    return events
      .filter((event: any) => Boolean(event.start && event.id))
      .map((event: any) => this.convertToCalendarEvent(event));
  }

  /**
   * Creates a new event in the calendar
   */
  async createEvent(calendarId: string, event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    winston.debug("Creating calendar event", { calendarId, event });

    const response = await this.calendar.events.insert({
      calendarId,
      requestBody: this.convertToGoogleEvent(event),
    });

    if (!response.data.id) {
      throw new Error("Failed to create event: no ID returned");
    }

    winston.info("Created calendar event", { eventId: response.data.id });
    return this.convertToCalendarEvent(response.data);
  }

  /**
   * Updates an existing event in the calendar
   */
  async updateEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent> {
    winston.debug("Updating calendar event", { calendarId, eventId: event.id });

    const response = await this.calendar.events.update({
      calendarId,
      eventId: event.id,
      requestBody: this.convertToGoogleEvent(event),
    });

    if (!response.data.id) {
      throw new Error("Failed to update event: no ID returned");
    }

    winston.info("Updated calendar event", { eventId: response.data.id });
    return this.convertToCalendarEvent(response.data);
  }

  /**
   * Deletes an event from the calendar
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    winston.debug("Deleting calendar event", { calendarId, eventId });

    await this.calendar.events.delete({
      calendarId,
      eventId,
    });

    winston.info("Deleted calendar event", { eventId });
  }

  /**
   * Converts a Google Calendar event to a CalendarEvent
   */
  private convertToCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
    const allDay = !event.start?.dateTime;
    const startTime = allDay ? DateTime.fromISO(event.start?.date!) : DateTime.fromISO(event.start?.dateTime!);
    const endTime = allDay ? DateTime.fromISO(event.end?.date!) : DateTime.fromISO(event.end?.dateTime!);

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

  /**
   * Converts a CalendarEvent to a Google Calendar event
   */
  private convertToGoogleEvent(event: Partial<CalendarEvent>): calendar_v3.Schema$Event {
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
}

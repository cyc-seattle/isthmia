import { Auth } from "googleapis";
import winston from "winston";
import { DateTime } from "luxon";
import { CalendarClient, SpreadsheetClient, Worksheet, CalendarEvent, Calendar } from "@cyc-seattle/gsuite";
import type { GoogleSpreadsheetRow } from "google-spreadsheet";

/**
 * Represents a calendar row in the Calendars worksheet
 */
type CalendarRow = {
  readonly Name: string;
  readonly ID: string;
};

/**
 * Represents an event row in the events worksheet
 */
type EventRow = {
  readonly "Event ID": string;
  readonly "Start Date": string;
  readonly "End Date": string;
  readonly Calendar: string;
  readonly Labels: string;
  readonly Title: string;
  readonly Location: string;
  readonly Description: string;
};

/**
 * Formats labels for display in calendar event title
 * Example: ["Camp", "Session A"] + "Event Name" => "[Camp] [Session A] Event Name"
 */
function formatTitleWithLabels(title: string, labels?: string): string {
  if (!labels || labels.trim() === "") {
    return title;
  }

  const labelArray = labels
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l !== "");

  if (labelArray.length === 0) {
    return title;
  }

  const formattedLabels = labelArray.map((label) => `[${label}]`).join(" ");
  return `${formattedLabels} ${title}`;
}

class CalendarEventData {
  readonly event: CalendarEvent;
  readonly calendarName: string;

  constructor(public eventRow: GoogleSpreadsheetRow<EventRow>) {
    const title = eventRow.get("Title");
    const labels = eventRow.get("Labels");

    const startDateStr = eventRow.get("Start Date");
    const endDateStr = eventRow.get("End Date");
    const startTime = DateTime.fromFormat(startDateStr, "M/d/yyyy");
    // If End Date is blank, use Start Date
    // For all-day events, end date is exclusive (midnight of the day after)
    const parsedEndTime =
      endDateStr && endDateStr.trim() !== "" ? DateTime.fromFormat(endDateStr, "M/d/yyyy") : startTime;
    const endTime = parsedEndTime.plus({ days: 1 });

    this.calendarName = eventRow.get("Calendar");

    this.event = {
      id: eventRow.get("Event ID") || "",
      title: formatTitleWithLabels(title, labels),
      startTime,
      endTime,
      allDay: true,
      description: eventRow.get("Description"),
      location: eventRow.get("Location"),
    };
  }
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  created: number;
  updated: number;
}

/**
 * Syncs events from Google Spreadsheet to Google Calendar
 */
export class CalendarSyncClient {
  private spreadsheetClient: SpreadsheetClient;
  private calendarClient: CalendarClient;

  constructor(
    auth: Auth.GoogleAuth,
    private spreadsheetId: string,
    private calendarWorksheetName: string = "Calendars",
    private eventsWorksheetName: string = "Events",
  ) {
    this.spreadsheetClient = new SpreadsheetClient(auth);
    this.calendarClient = new CalendarClient(auth);
  }

  /**
   * Initialize the spreadsheet
   */
  async initialize(): Promise<CalendarSync> {
    const spreadsheet = await this.spreadsheetClient.loadSpreadsheet(this.spreadsheetId);
    winston.info("Spreadsheet loaded", { title: spreadsheet.title });

    const calendarSheet = await spreadsheet.getOrCreateWorksheet<CalendarRow>(this.calendarWorksheetName, [
      "Name",
      "ID",
    ]);

    const eventsSheet = await spreadsheet.getOrCreateWorksheet<EventRow>(this.eventsWorksheetName, [
      "Event ID",
      "Start Date",
      "End Date",
      "Calendar",
      "Labels",
      "Title",
      "Location",
      "Description",
    ]);

    return new CalendarSync(this.calendarClient, calendarSheet, eventsSheet);
  }
}

export class CalendarSync {
  constructor(
    private calendarClient: CalendarClient,
    private calendarSheet: Worksheet<CalendarRow>,
    private eventsSheet: Worksheet<EventRow>,
  ) {}

  /**
   * Lists all calendars from the Calendars worksheet
   * Returns a map of calendar names to Calendar objects
   */
  private async listCalendars(): Promise<Map<string, Calendar>> {
    winston.debug("Listing calendars from spreadsheet");
    const rows = await this.calendarSheet.getRows();

    const calendars = new Map<string, Calendar>();
    for (const row of rows) {
      const name = row.get("Name");
      const id = row.get("ID");

      if (name && id) {
        const calendar = this.calendarClient.loadCalendar(id);
        calendars.set(name, calendar);
      }
    }

    winston.info(`Found ${calendars.size} calendars in spreadsheet`);
    return calendars;
  }

  /**
   * Lists all events from the spreadsheet
   */
  private async listEvents(): Promise<CalendarEventData[]> {
    const events: CalendarEventData[] = [];
    const rows = await this.eventsSheet.getRows();

    for (const row of rows) {
      const startDate = row.get("Start Date");
      const title = row.get("Title");
      const calendar = row.get("Calendar");

      // Skip if Start Date is blank (tentative events)
      if (!startDate || startDate.trim() === "") {
        winston.debug("Skipping tentative event (blank Start Date)", { title });
        continue;
      }

      // Must have title and calendar
      if (!title || !calendar) {
        winston.debug("Skipping event with missing title or calendar", { title, calendar });
        continue;
      }

      events.push(new CalendarEventData(row));
    }

    winston.info(`Found ${events.length} events in spreadsheet`);
    return events;
  }

  /**
   * Syncs events from spreadsheet to all calendars
   */
  async sync(): Promise<SyncResult> {
    winston.info("Starting sync operation");

    const result: SyncResult = {
      created: 0,
      updated: 0,
    };

    // Load calendars and events
    const calendars = await this.listCalendars();
    const events = await this.listEvents();

    if (calendars.size === 0) {
      winston.warn("No calendars found in Calendars worksheet");
      return result;
    }

    winston.info(`Found ${calendars.size} calendars and ${events.length} events to sync`);

    // Sync each event
    for (const eventData of events) {
      const calendar = calendars.get(eventData.calendarName);

      if (!calendar) {
        winston.warn(`Calendar not found for event`, { calendar: eventData.calendarName, event: eventData.event.id });
        continue;
      }

      await this.syncEvent(calendar, eventData, result);
    }

    winston.info("Sync operation completed", { result });
    return result;
  }

  /**
   * Syncs a single event to its calendar
   */
  private async syncEvent(calendar: Calendar, eventData: CalendarEventData, result: SyncResult): Promise<void> {
    const event = eventData.event;
    const oldId = event.id;

    // If Event ID is blank, create new event
    if (!oldId || oldId.trim() === "") {
      winston.debug("Creating new event (blank ID)", { title: event.title });
      const created = await calendar.createEvent(calendar.calendarId, event);

      // Update spreadsheet with the generated ID
      eventData.eventRow.set("Event ID", created.id);
      await eventData.eventRow.save();
      result.created++;
    } else {
      // Check if event exists in calendar
      const existingEvent = await calendar.getEvent(oldId);

      if (existingEvent) {
        // Always update existing events
        await calendar.updateEvent(calendar.calendarId, event);
        result.updated++;
      } else {
        // Event ID exists in spreadsheet but not in calendar - create it
        winston.debug("Creating event with provided ID", { id: oldId, title: event.title });
        await calendar.createEvent(calendar.calendarId, event);
        result.created++;
      }
    }
  }
}

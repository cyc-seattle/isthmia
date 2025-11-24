import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { Auth } from "googleapis";
import winston from "winston";
import { DateTime } from "luxon";
import { CalendarEvent } from "./types.js";
import { safeCall } from "@cyc-seattle/gsuite";

/**
 * Represents a row in the spreadsheet
 */
interface EventRow {
  "Event Id": string;
  Title: string;
  Description: string;
  "Start Time": string;
  "End Time": string;
  Location: string;
  "All Day": string;
  [key: string]: string;
}

/**
 * Column name mapping between code field names and human-readable headers
 */
const COLUMN_HEADERS = {
  id: "Event Id",
  title: "Title",
  description: "Description",
  startTime: "Start Time",
  endTime: "End Time",
  location: "Location",
  allDay: "All Day",
} as const;

/**
 * Google Spreadsheet API wrapper for calendar events
 */
export class SpreadsheetClient {
  private doc: GoogleSpreadsheet;

  constructor(auth: Auth.GoogleAuth, spreadsheetId: string) {
    this.doc = new GoogleSpreadsheet(spreadsheetId, auth);
  }

  /**
   * Initialize the spreadsheet document
   */
  async initialize(): Promise<void> {
    await safeCall(() => this.doc.loadInfo());
    winston.info("Spreadsheet loaded", { title: this.doc.title });
  }

  /**
   * Get or create a worksheet
   */
  private async getOrCreateWorksheet(worksheetName: string): Promise<GoogleSpreadsheetWorksheet> {
    let worksheet = this.doc.sheetsByTitle[worksheetName];

    if (!worksheet) {
      winston.info("Creating new worksheet", { worksheetName });
      worksheet = await safeCall(() =>
        this.doc.addSheet({
          title: worksheetName,
          headerValues: Object.values(COLUMN_HEADERS),
        }),
      );
    }

    return worksheet;
  }

  /**
   * Lists all events from the spreadsheet
   */
  async listEvents(worksheetName: string): Promise<CalendarEvent[]> {
    winston.debug("Listing events from spreadsheet", { worksheetName });

    const worksheet = await this.getOrCreateWorksheet(worksheetName);
    const rows = await safeCall(() => worksheet.getRows<EventRow>({ limit: 10000 }));

    winston.info(`Found ${rows.length} events in spreadsheet`);

    return rows
      .filter((row) => row.get(COLUMN_HEADERS.id) && row.get(COLUMN_HEADERS.title))
      .map((row) => this.convertToCalendarEvent(row));
  }

  /**
   * Adds a new event to the spreadsheet
   */
  async addEvent(worksheetName: string, event: Omit<CalendarEvent, "id"> & { id?: string }): Promise<CalendarEvent> {
    winston.debug("Adding event to spreadsheet", { worksheetName, event });

    const worksheet = await this.getOrCreateWorksheet(worksheetName);
    const rowData = this.convertToRowData(event);

    await safeCall(() => worksheet.addRow(rowData));
    winston.info("Added event to spreadsheet", { eventId: event.id });

    return event as CalendarEvent;
  }

  /**
   * Updates an existing event in the spreadsheet
   */
  async updateEvent(worksheetName: string, event: CalendarEvent): Promise<CalendarEvent> {
    winston.debug("Updating event in spreadsheet", {
      worksheetName,
      eventId: event.id,
    });

    const worksheet = await this.getOrCreateWorksheet(worksheetName);
    const rows = await safeCall(() => worksheet.getRows<EventRow>({ limit: 10000 }));

    const row = rows.find((r) => r.get(COLUMN_HEADERS.id) === event.id);
    if (!row) {
      throw new Error(`Event not found in spreadsheet: ${event.id}`);
    }

    const rowData = this.convertToRowData(event);
    Object.entries(rowData).forEach(([key, value]) => {
      row.set(key, value);
    });

    await safeCall(() => row.save());
    winston.info("Updated event in spreadsheet", { eventId: event.id });

    return event;
  }

  /**
   * Deletes an event from the spreadsheet
   */
  async deleteEvent(worksheetName: string, eventId: string): Promise<void> {
    winston.debug("Deleting event from spreadsheet", {
      worksheetName,
      eventId,
    });

    const worksheet = await this.getOrCreateWorksheet(worksheetName);
    const rows = await safeCall(() => worksheet.getRows<EventRow>({ limit: 10000 }));

    const row = rows.find((r) => r.get(COLUMN_HEADERS.id) === eventId);
    if (!row) {
      winston.warn("Event not found in spreadsheet", { eventId });
      return;
    }

    await safeCall(() => row.delete());
    winston.info("Deleted event from spreadsheet", { eventId });
  }

  /**
   * Converts a spreadsheet row to a CalendarEvent
   */
  private convertToCalendarEvent(row: any): CalendarEvent {
    const id = row.get(COLUMN_HEADERS.id);
    const title = row.get(COLUMN_HEADERS.title);
    const description = row.get(COLUMN_HEADERS.description);
    const startTime = row.get(COLUMN_HEADERS.startTime);
    const endTime = row.get(COLUMN_HEADERS.endTime);
    const location = row.get(COLUMN_HEADERS.location);
    const allDay = row.get(COLUMN_HEADERS.allDay);

    const metadata: Record<string, string> = {};
    const standardFields = new Set([...Object.values(COLUMN_HEADERS), "_rowNumber", "_worksheet"]);

    // Extract any additional columns as metadata
    const headers = row._worksheet.headerValues;
    for (const header of headers) {
      if (!standardFields.has(header)) {
        const value = row.get(header);
        if (typeof value === "string" && value.length > 0) {
          metadata[header] = value;
        }
      }
    }

    const calEvent: CalendarEvent = {
      id,
      title,
      startTime: DateTime.fromISO(startTime),
      endTime: DateTime.fromISO(endTime),
      allDay: allDay === "true" || allDay === "TRUE",
    };

    if (description) {
      calEvent.description = description;
    }
    if (location) {
      calEvent.location = location;
    }
    if (Object.keys(metadata).length > 0) {
      calEvent.metadata = metadata;
    }

    return calEvent;
  }

  /**
   * Converts a CalendarEvent to spreadsheet row data
   */
  private convertToRowData(event: Partial<CalendarEvent>): EventRow {
    const rowData: EventRow = {
      [COLUMN_HEADERS.id]: event.id ?? "",
      [COLUMN_HEADERS.title]: event.title ?? "",
      [COLUMN_HEADERS.description]: event.description ?? "",
      [COLUMN_HEADERS.startTime]: event.startTime?.toISO() ?? "",
      [COLUMN_HEADERS.endTime]: event.endTime?.toISO() ?? "",
      [COLUMN_HEADERS.location]: event.location ?? "",
      [COLUMN_HEADERS.allDay]: event.allDay ? "TRUE" : "FALSE",
    };

    // Add metadata as additional columns
    if (event.metadata) {
      Object.entries(event.metadata).forEach(([key, value]) => {
        rowData[key] = value;
      });
    }

    return rowData;
  }

  /**
   * Clears all events from the spreadsheet
   */
  async clearEvents(worksheetName: string): Promise<void> {
    winston.debug("Clearing all events from spreadsheet", { worksheetName });

    const worksheet = await this.getOrCreateWorksheet(worksheetName);
    await safeCall(() => worksheet.clear());

    // Re-add headers
    await safeCall(() => worksheet.setHeaderRow(Object.values(COLUMN_HEADERS)));

    winston.info("Cleared all events from spreadsheet");
  }
}

import { DateTime } from "luxon";

/**
 * Represents an event that can be synced between Google Calendar and Spreadsheet
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
 * Configuration for Google Calendar API
 */
export interface CalendarConfig {
  /** Google Calendar ID */
  calendarId: string;
}

/**
 * Configuration for Google Spreadsheet
 */
export interface SpreadsheetConfig {
  /** Spreadsheet URL or ID */
  spreadsheetId: string;
  /** Worksheet name or index */
  worksheetName: string;
}

/**
 * Sync configuration
 */
export interface SyncConfig {
  calendar: CalendarConfig;
  spreadsheet: SpreadsheetConfig;
  /** Direction of sync: calendar->sheet or sheet->calendar */
  direction: "to-spreadsheet" | "to-calendar";
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** Number of events created */
  created: number;
  /** Number of events updated */
  updated: number;
  /** Number of events deleted */
  deleted: number;
  /** Errors encountered during sync */
  errors: Error[];
}

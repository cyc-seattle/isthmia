import winston from "winston";
import { CalendarClient } from "@cyc-seattle/gsuite";
import { SpreadsheetClient } from "./spreadsheet.js";
import { CalendarEvent, SyncConfig, SyncResult } from "./types.js";
import { DateTime } from "luxon";

/**
 * Syncs events between Google Calendar and Google Spreadsheet
 */
export class EventSynchronizer {
  constructor(
    private calendar: CalendarClient,
    private spreadsheet: SpreadsheetClient,
  ) {}

  /**
   * Performs a sync operation based on the configuration
   */
  async sync(config: SyncConfig, timeMin?: DateTime, timeMax?: DateTime): Promise<SyncResult> {
    winston.info("Starting sync operation", { config, timeMin, timeMax });

    const result: SyncResult = {
      created: 0,
      updated: 0,
      deleted: 0,
      errors: [],
    };

    try {
      if (config.direction === "to-spreadsheet") {
        await this.syncCalendarToSpreadsheet(config, timeMin, timeMax, result);
      } else {
        await this.syncSpreadsheetToCalendar(config, result);
      }
    } catch (error) {
      winston.error("Sync operation failed", { error });
      result.errors.push(error instanceof Error ? error : new Error(String(error)));
    }

    winston.info("Sync operation completed", { result });
    return result;
  }

  /**
   * Syncs events from Calendar to Spreadsheet (one-way)
   */
  private async syncCalendarToSpreadsheet(
    config: SyncConfig,
    timeMin: DateTime | undefined,
    timeMax: DateTime | undefined,
    result: SyncResult,
  ): Promise<void> {
    winston.info("Syncing calendar to spreadsheet");

    const calendarEvents = await this.calendar.listEvents(config.calendar.calendarId, timeMin, timeMax);
    const spreadsheetEvents = await this.spreadsheet.listEvents(config.spreadsheet.worksheetName);

    const spreadsheetEventsMap = new Map(spreadsheetEvents.map((e) => [e.id, e]));

    for (const calEvent of calendarEvents) {
      try {
        const existingEvent = spreadsheetEventsMap.get(calEvent.id);

        if (existingEvent) {
          // Update if different
          if (this.eventsAreDifferent(calEvent, existingEvent)) {
            await this.spreadsheet.updateEvent(config.spreadsheet.worksheetName, calEvent);
            result.updated++;
          }
        } else {
          // Create new
          await this.spreadsheet.addEvent(config.spreadsheet.worksheetName, calEvent);
          result.created++;
        }

        spreadsheetEventsMap.delete(calEvent.id);
      } catch (error) {
        winston.error("Failed to sync event to spreadsheet", {
          event: calEvent,
          error,
        });
        result.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Delete events that no longer exist in calendar
    for (const [eventId] of spreadsheetEventsMap) {
      try {
        await this.spreadsheet.deleteEvent(config.spreadsheet.worksheetName, eventId);
        result.deleted++;
      } catch (error) {
        winston.error("Failed to delete event from spreadsheet", {
          eventId,
          error,
        });
        result.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Syncs events from Spreadsheet to Calendar (one-way)
   */
  private async syncSpreadsheetToCalendar(config: SyncConfig, result: SyncResult): Promise<void> {
    winston.info("Syncing spreadsheet to calendar");

    const spreadsheetEvents = await this.spreadsheet.listEvents(config.spreadsheet.worksheetName);
    const calendarEvents = await this.calendar.listEvents(config.calendar.calendarId);

    const calendarEventsMap = new Map(calendarEvents.map((e) => [e.id, e]));

    for (const sheetEvent of spreadsheetEvents) {
      try {
        const existingEvent = calendarEventsMap.get(sheetEvent.id);

        if (existingEvent) {
          // Update if different
          if (this.eventsAreDifferent(sheetEvent, existingEvent)) {
            await this.calendar.updateEvent(config.calendar.calendarId, sheetEvent);
            result.updated++;
          }
        } else {
          // Create new
          const created = await this.calendar.createEvent(config.calendar.calendarId, sheetEvent);
          // Update spreadsheet with the new ID if it was generated
          if (created.id !== sheetEvent.id) {
            sheetEvent.id = created.id;
            await this.spreadsheet.updateEvent(config.spreadsheet.worksheetName, sheetEvent);
          }
          result.created++;
        }

        calendarEventsMap.delete(sheetEvent.id);
      } catch (error) {
        winston.error("Failed to sync event to calendar", {
          event: sheetEvent,
          error,
        });
        result.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Delete events that no longer exist in spreadsheet
    for (const [eventId] of calendarEventsMap) {
      try {
        await this.calendar.deleteEvent(config.calendar.calendarId, eventId);
        result.deleted++;
      } catch (error) {
        winston.error("Failed to delete event from calendar", {
          eventId,
          error,
        });
        result.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Checks if two events are different (ignoring minor differences)
   */
  private eventsAreDifferent(event1: CalendarEvent, event2: CalendarEvent): boolean {
    return (
      event1.title !== event2.title ||
      event1.description !== event2.description ||
      !event1.startTime.equals(event2.startTime) ||
      !event1.endTime.equals(event2.endTime) ||
      event1.location !== event2.location ||
      event1.allDay !== event2.allDay
    );
  }
}

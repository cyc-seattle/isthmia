#!/usr/bin/env -S npx tsx

import { Command } from "@commander-js/extra-typings";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import winston from "winston";
import { google } from "googleapis";
import { CalendarClient } from "@cyc-seattle/gsuite";
import { SpreadsheetClient } from "./spreadsheet.js";
import { EventSynchronizer } from "./sync.js";
import { SyncConfig } from "./types.js";
import { DateTime } from "luxon";

const program = new Command("calendar-sync")
  .version("0.0.1")
  .description("Syncs events between Google Calendar and Google Spreadsheet")
  .addOption(new LoggingOption())
  .addOption(new VerboseOption("info"))
  .hook("preAction", (command) => {
    const opts = command.opts();
    winston.configure({
      level: opts.verbose ?? "info",
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });
  });

program
  .command("sync-to-spreadsheet")
  .description("Sync events from Google Calendar to Spreadsheet")
  .requiredOption("--calendar-id <id>", "Google Calendar ID (e.g., primary or calendar@group.calendar.google.com)")
  .requiredOption("--spreadsheet-id <id>", "Google Spreadsheet ID or URL")
  .requiredOption("--worksheet-name <name>", "Worksheet name in the spreadsheet")
  .option("--sync-from <date>", "Sync events from this date/time (ISO format, e.g., 2024-01-01)")
  .option("--sync-to <date>", "Sync events until this date/time (ISO format, e.g., 2024-12-31)")
  .action(async (options) => {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"],
      });

      winston.info("Initializing Google API clients");

      const spreadsheetId = extractSpreadsheetId(options.spreadsheetId);
      const calendarClient = new CalendarClient(auth);
      const spreadsheetClient = new SpreadsheetClient(auth, spreadsheetId);
      await spreadsheetClient.initialize();

      const synchronizer = new EventSynchronizer(calendarClient, spreadsheetClient);

      const syncFrom = options.syncFrom ? DateTime.fromISO(options.syncFrom) : undefined;
      const syncTo = options.syncTo ? DateTime.fromISO(options.syncTo) : undefined;

      const config: SyncConfig = {
        calendar: {
          calendarId: options.calendarId,
        },
        spreadsheet: {
          spreadsheetId,
          worksheetName: options.worksheetName,
        },
        direction: "to-spreadsheet",
      };

      const result = await synchronizer.sync(config, syncFrom, syncTo);

      winston.info("Sync completed", {
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        errors: result.errors.length,
      });

      if (result.errors.length > 0) {
        winston.error("Errors occurred during sync", {
          errors: result.errors.map((e) => e.message),
        });
        process.exit(1);
      }
    } catch (error) {
      winston.error("Sync failed", { error });
      process.exit(1);
    }
  });

program
  .command("sync-to-calendar")
  .description("Sync events from Spreadsheet to Google Calendar")
  .requiredOption("--calendar-id <id>", "Google Calendar ID (e.g., primary or calendar@group.calendar.google.com)")
  .requiredOption("--spreadsheet-id <id>", "Google Spreadsheet ID or URL")
  .requiredOption("--worksheet-name <name>", "Worksheet name in the spreadsheet")
  .action(async (options) => {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"],
      });

      winston.info("Initializing Google API clients");

      const spreadsheetId = extractSpreadsheetId(options.spreadsheetId);
      const calendarClient = new CalendarClient(auth);
      const spreadsheetClient = new SpreadsheetClient(auth, spreadsheetId);
      await spreadsheetClient.initialize();

      const synchronizer = new EventSynchronizer(calendarClient, spreadsheetClient);

      const config: SyncConfig = {
        calendar: {
          calendarId: options.calendarId,
        },
        spreadsheet: {
          spreadsheetId,
          worksheetName: options.worksheetName,
        },
        direction: "to-calendar",
      };

      const result = await synchronizer.sync(config);

      winston.info("Sync completed", {
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        errors: result.errors.length,
      });

      if (result.errors.length > 0) {
        winston.error("Errors occurred during sync", {
          errors: result.errors.map((e) => e.message),
        });
        process.exit(1);
      }
    } catch (error) {
      winston.error("Sync failed", { error });
      process.exit(1);
    }
  });

program
  .command("list-calendar")
  .description("List events from Google Calendar")
  .requiredOption("--calendar-id <id>", "Google Calendar ID")
  .option("--sync-from <date>", "List events from this date/time (ISO format)")
  .option("--sync-to <date>", "List events until this date/time (ISO format)")
  .action(async (options) => {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });

      const calendarClient = new CalendarClient(auth);
      const syncFrom = options.syncFrom ? DateTime.fromISO(options.syncFrom) : undefined;
      const syncTo = options.syncTo ? DateTime.fromISO(options.syncTo) : undefined;

      const events = await calendarClient.listEvents(options.calendarId, syncFrom, syncTo);

      console.log(JSON.stringify(events, null, 2));
    } catch (error) {
      winston.error("Failed to list calendar events", { error });
      process.exit(1);
    }
  });

program
  .command("list-spreadsheet")
  .description("List events from Google Spreadsheet")
  .requiredOption("--spreadsheet-id <id>", "Google Spreadsheet ID or URL")
  .requiredOption("--worksheet-name <name>", "Worksheet name")
  .action(async (options) => {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const spreadsheetId = extractSpreadsheetId(options.spreadsheetId);
      const spreadsheetClient = new SpreadsheetClient(auth, spreadsheetId);
      await spreadsheetClient.initialize();

      const events = await spreadsheetClient.listEvents(options.worksheetName);

      console.log(JSON.stringify(events, null, 2));
    } catch (error) {
      winston.error("Failed to list spreadsheet events", { error });
      process.exit(1);
    }
  });

/**
 * Extracts spreadsheet ID from URL or returns the ID as-is
 */
function extractSpreadsheetId(urlOrId: string): string {
  try {
    const url = new URL(urlOrId);
    const pathSegments = url.pathname.split("/");

    if (pathSegments.length < 4) {
      throw new Error(`Cannot extract spreadsheet ID from ${urlOrId}`);
    }

    return pathSegments[3]!;
  } catch {
    // If it's not a valid URL, assume it's already an ID
    return urlOrId;
  }
}

program.parse();

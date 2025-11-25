#!/usr/bin/env -S npx tsx

import { Command } from "@commander-js/extra-typings";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import winston from "winston";
import { google } from "googleapis";
import { CalendarSyncClient } from "./calendar.js";

const program = new Command("calendar-sync")
  .version("0.0.1")
  .description("Syncs events from Google Spreadsheet to Google Calendar")
  .requiredOption("--spreadsheet-id <id>", "Google Spreadsheet ID or URL")
  .option("--events-worksheet <name>", "Events worksheet name (default: Events)", "Events")
  .option("--calendars-worksheet <name>", "Calendars worksheet name (default: Calendars)", "Calendars")
  .addOption(new LoggingOption())
  .addOption(new VerboseOption("info"))
  .hook("preAction", (command) => {
    const opts = command.opts();
    winston.configure({
      level: opts.verbose ?? "info",
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });
  })
  .action(async (options) => {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"],
      });

      winston.info("Initializing calendar sync");

      const client = new CalendarSyncClient(
        auth,
        options.spreadsheetId,
        options.calendarsWorksheet,
        options.eventsWorksheet,
      );
      const sync = await client.initialize();

      const result = await sync.sync();

      winston.info("Sync completed", {
        created: result.created,
        updated: result.updated,
      });
    } catch (error) {
      winston.error("Sync failed", { error });
      process.exit(1);
    }
  });

program.parse();

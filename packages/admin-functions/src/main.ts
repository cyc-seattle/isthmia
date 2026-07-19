#!/usr/bin/env -S npx tsx

import { Command, Option } from "@commander-js/extra-typings";
import winston from "winston";
import { Clubspot, ClubspotUsernameOption, ClubspotPasswordOption } from "@cyc-seattle/clubspot-sdk";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import { Auth, google } from "googleapis";
import { ReportRunner } from "./runner.js";
import { RosterGenerator } from "./roster.js";

// Outh Scopes: https://developers.google.com/identity/protocols/oauth2/scopes
const auth: Auth.GoogleAuth = new google.auth.GoogleAuth({
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    // `drive` (not `drive.file`) is required to create rosters inside a shared-drive
    // folder the app did not itself create.
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/cloud-platform",
  ],
});

const clubspot = new Clubspot();
const reportRunner = new ReportRunner(auth);

// TODO: dry run option
const program = new Command("admin-scripts")
  .addOption(new ClubspotUsernameOption())
  .addOption(new ClubspotPasswordOption())
  .addOption(new LoggingOption())
  .addOption(new VerboseOption("info"))
  .hook("preAction", async (command, action) => {
    const opts = command.opts();

    winston.configure({
      level: opts.verbose ?? "info",
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });

    await clubspot.initialize(opts.username, opts.password);

    winston.debug("Executing action", {
      action: action.name(),
      options: action.opts(),
    });
  });

const configSheetOption = new Option("--config-spreadsheet <id>", "The ID of the configuration spreadsheet")
  .env("CONFIG_SPREADSHEET_ID")
  .makeOptionMandatory();

program
  .command("all")
  .description("Runs all reports defined in the specified config spreadsheet.")
  .addOption(configSheetOption)
  .action(async (options) => {
    await reportRunner.runAll(options.configSpreadsheet);
  });

const rosterFolderOption = new Option("--folder <id>", "Drive folder id to create the roster in")
  .env("ROSTER_FOLDER_ID")
  .default("1Iu6x4t0bFE_Yt0MMV21fvEOQpt_xocEU");

program
  .command("roster")
  .description("Generates a fresh camp roster (Public + Medical tabs) for one camp session.")
  .requiredOption("--camp <id>", "The Clubspot camp id")
  .requiredOption("--session <name-or-id>", "The session (week) name or id")
  .addOption(rosterFolderOption)
  .action(async (options) => {
    const generator = new RosterGenerator({
      auth,
      campId: options.camp,
      session: options.session,
      folderId: options.folder,
    });
    const url = await generator.generate();
    winston.info(`Roster created: ${url}`);
  });

try {
  await program.parseAsync();
} catch (error) {
  winston.error("Unhandled error", { error });
  process.exit(-1);
}

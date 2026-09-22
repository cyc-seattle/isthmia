#!/usr/bin/env -S npx tsx

import { fileURLToPath } from "node:url";
import { Command, Option } from "@commander-js/extra-typings";
import { google } from "googleapis";
import winston from "winston";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import { DirectusClient, SyncQueue } from "@cyc-seattle/directus";
import { DirectoryClient } from "@cyc-seattle/gsuite";
import { dryRunMemberAdder, MemberAdder } from "./directory-writer.js";
import { runMembershipSync } from "./run.js";

// Membership only needs the Directory API's group-member scope - the wider
// apps.groups.settings scope the settings pass needs is added when that pass lands.
const SCOPES = ["https://www.googleapis.com/auth/admin.directory.group"];

const program = new Command("gsuite-sync")
  .description("Syncs class group membership from the CRM's Directus instance into Google Groups")
  .addOption(new LoggingOption())
  .addOption(new VerboseOption("info"))
  .addOption(
    new Option("--directus-url <url>", "The base URL of the CRM's Directus instance")
      .env("DIRECTUS_URL")
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--directus-token <token>",
      "A Directus static token for the sync's machine user (prefer DIRECTUS_TOKEN)",
    )
      .env("DIRECTUS_TOKEN")
      .makeOptionMandatory(),
  )
  .option("--dry-run", "Log the writes the sync would make, without making them")
  .hook("preAction", (command) => {
    const opts = command.opts();
    winston.configure({
      level: opts.verbose ?? "info",
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });
  })
  .action(async (options) => {
    const dryRun = options.dryRun ?? false;
    const directus = new DirectusClient(options.directusUrl, options.directusToken, dryRun);
    const queue = new SyncQueue(directus);

    const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
    const adder: MemberAdder = dryRun ? dryRunMemberAdder() : new DirectoryClient(auth);

    const result = await runMembershipSync({ now: new Date(), directus, queue, adder });

    winston.info("Membership sync run finished", result);

    if (result.status === "failed") {
      process.exitCode = 1;
    }
  });

// Guards the CLI run so tests can import this module without commander parsing the test runner's
// own argv and exiting the process out from under it - see clubspot-sync/src/main.ts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await program.parseAsync();
  } catch (error) {
    winston.error("Unhandled error", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    process.exitCode = 1;
  }
}

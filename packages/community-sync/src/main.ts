#!/usr/bin/env -S npx tsx

import { fileURLToPath } from "node:url";
import { Command, Option } from "@commander-js/extra-typings";
import { google } from "googleapis";
import winston from "winston";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import { DirectusClient } from "@cyc-seattle/directus";
import { DirectoryClient } from "@cyc-seattle/gsuite";
import { AuthentikClient, dryRunAuthentikClient, HttpAuthentikClient } from "./authentik.js";
import { runCommunitySync } from "./run.js";

// Mirroring all@ only ever reads group membership.
const SCOPES = ["https://www.googleapis.com/auth/admin.directory.group.readonly"];

const program = new Command("community-sync")
  .description(
    "Writes people.login_email, mirrors all@ into Authentik's staff group, and - once enabled - adds current participants and guardians to Authentik's families group",
  )
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
  .addOption(
    new Option("--authentik-url <url>", "The base URL of the Authentik instance")
      .env("AUTHENTIK_URL")
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--authentik-token <token>",
      "An Authentik API token for the sync's service account (prefer AUTHENTIK_TOKEN)",
    )
      .env("AUTHENTIK_TOKEN")
      .makeOptionMandatory(),
  )
  .addOption(
    new Option("--staff-source-group <email>", "The Google Group the staff pass mirrors into Authentik")
      .env("COMMUNITY_SYNC_STAFF_GROUP")
      .default("all@cyccommunitysailing.org"),
  )
  .addOption(
    new Option(
      "--families",
      "Enable the family pass, adding current participants and their guardians to the families group - off until the board approves sharing names and contact information",
    )
      // A boolean flag's env var only ever turns it on: commander enables it whenever the
      // variable is merely defined, regardless of its value, so the deployed job leaves this
      // unset until the board approves the family pass rather than setting it "false".
      .env("COMMUNITY_SYNC_FAMILIES")
      .default(false),
  )
  .option(
    "--allow-large-removal",
    "Allow a group reconcile that would empty the group or remove more than half its current members - refused by default so a collapsed source read can't lock everyone out",
    false,
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

    const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
    const directory = new DirectoryClient(auth);

    const realAuthentik = new HttpAuthentikClient(options.authentikUrl, options.authentikToken);
    const authentik: AuthentikClient = dryRun ? dryRunAuthentikClient(realAuthentik) : realAuthentik;

    const result = await runCommunitySync({
      now: new Date(),
      directus,
      authentik,
      directory,
      staffSourceGroup: options.staffSourceGroup,
      families: options.families,
      allowLargeRemoval: options.allowLargeRemoval,
    });

    winston.info("Community sync run finished", result);

    if (result.status === "failed") {
      process.exitCode = 1;
    }
  });

// Guards the CLI run so tests can import this module without commander parsing the test runner's
// own argv and exiting the process out from under it - see gsuite-sync/src/main.ts.
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

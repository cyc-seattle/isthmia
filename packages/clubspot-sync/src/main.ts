#!/usr/bin/env -S npx tsx

import { Command, Option } from "@commander-js/extra-typings";
import winston from "winston";
import {
  Camp,
  CampClass,
  CampSession,
  Clubspot,
  ClubspotPasswordOption,
  ClubspotUsernameOption,
  LoggedQuery,
  queryCampEntries,
} from "@cyc-seattle/clubspot-sdk";
import { LoggingOption, VerboseOption } from "@cyc-seattle/commodore";
import { discoverCamps } from "./camps.js";
import { countChildChanges } from "./change-detection.js";
import { DirectusClient } from "./directus.js";
import { PersonSync } from "./person-sync.js";
import { CampData, runSync, SyncGateway } from "./sync-run.js";
import { SyncLog } from "./sync-log.js";

const clubspot = new Clubspot();

/**
 * Every child object a camp's schedule and registration passes need, queried directly rather than
 * through `Camp.customFieldsArray`'s unfetched pointers - see `sessions.ts:56` for the same
 * `campObject` query shape.
 */
async function fetchCampData(camp: Camp): Promise<CampData> {
  const hydratedCamp = await new LoggedQuery(Camp).include("customFieldsArray").get(camp.id);

  const sessions = await new LoggedQuery(CampSession)
    .equalTo("campObject", camp)
    .notEqualTo("archived", true)
    .include("campClassesArray")
    .find();

  const classes = await new LoggedQuery(CampClass).equalTo("campObject", camp).include("entryCapsArray").find();
  const entryCaps = classes.flatMap((campClass) => campClass.get("entryCapsArray") ?? []);

  const registrations = await queryCampEntries(camp).find();

  return { camp: hydratedCamp, classes, sessions, entryCaps, registrations };
}

const gateway: SyncGateway = {
  discoverCamps,
  getCamp: (campId) => new LoggedQuery(Camp).get(campId),
  countChildChanges,
  fetchCampData,
};

const program = new Command("clubspot-sync")
  .description("Syncs one Clubspot club's camps, schedule, and registrations into the CRM's Directus instance")
  .addOption(new ClubspotUsernameOption())
  .addOption(new ClubspotPasswordOption())
  .addOption(new LoggingOption())
  .addOption(new VerboseOption("info"))
  .addOption(new Option("--club <id>", "The Clubspot club id to sync").env("CLUBSPOT_CLUB_ID").makeOptionMandatory())
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
  .option("--camp <id>", "Sync only this camp, bypassing discovery and change detection")
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
  })
  .action(async (options) => {
    const directus = new DirectusClient(options.directusUrl, options.directusToken, options.dryRun ?? false);
    const syncLog = new SyncLog(directus);
    const personSync = new PersonSync(directus);

    const result = await runSync({
      clubId: options.club,
      ...(options.camp ? { campId: options.camp } : {}),
      now: new Date(),
      directus,
      syncLog,
      personSync,
      gateway,
    });

    winston.info("Sync run finished", result);

    if (result.status === "failed") {
      process.exitCode = 1;
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  winston.error("Unhandled error", {
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
  });
  process.exitCode = 1;
}

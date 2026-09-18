#!/usr/bin/env -S npx tsx

import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
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
import { DirectusClient } from "./directus.js";
import { findAll } from "./parse-paging.js";
import { PersonSync } from "./person-sync.js";
import { CampData, fetchCampDataGateway, runSync, SyncGateway } from "./sync-run.js";
import { SyncLog } from "./sync-log.js";

const clubspot = new Clubspot();

// These option values are long-lived credentials (the Directus static token) or a login
// password - never worth the risk of a debug-level run putting them in Cloud Logging.
const SECRET_OPTIONS = ["password", "directusToken"] as const;

function parseSince(value: string): Date {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    throw new InvalidArgumentError(`Not a valid date: ${value}`);
  }
  return parsed;
}

export function redactSecrets(opts: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...opts };
  for (const key of SECRET_OPTIONS) {
    if (key in redacted) {
      redacted[key] = "<redacted>";
    }
  }
  return redacted;
}

/** Both `--since` and `--include-archived` are per-camp backfills, and neither makes sense across a whole club. */
export function validateBackfillOptions(options: {
  camp?: string;
  since?: Date;
  includeArchived?: boolean;
}): string | undefined {
  if (options.since && !options.camp) {
    return "--since requires --camp: a backfill re-reads one camp, not the whole club.";
  }
  if (options.includeArchived && !options.camp) {
    return "--include-archived requires --camp: a backfill re-reads one camp, not the whole club.";
  }
  return undefined;
}

/**
 * Every child object a camp's schedule and registration passes need, queried directly rather than
 * through `Camp.customFieldsArray`'s unfetched pointers - see `sessions.ts:56` for the same
 * `campObject` query shape.
 *
 * Sessions and classes are the schedule pass, reconciled in full every run rather than filtered on
 * a watermark - see the design doc's "Shape of the sync" section. Registrations are the
 * watermark-filtered pass: only those Clubspot touched between the camp's watermark and this run's
 * start are fetched.
 */
async function fetchCampData(camp: Camp, watermark: Date, until: Date, includeArchived: boolean): Promise<CampData> {
  const hydratedCamp = await new LoggedQuery(Camp).include("customFieldsArray").get(camp.id);

  let sessionQuery = new LoggedQuery(CampSession).equalTo("campObject", camp).include("campClassesArray");
  if (!includeArchived) {
    sessionQuery = sessionQuery.notEqualTo("archived", true);
  }
  const sessions = await findAll(sessionQuery);

  const classes = await findAll(new LoggedQuery(CampClass).equalTo("campObject", camp).include("entryCapsArray"));
  const entryCaps = classes.flatMap((campClass) => campClass.get("entryCapsArray") ?? []);

  const registrations = await findAll(
    queryCampEntries(camp).greaterThanOrEqualTo("updatedAt", watermark).lessThan("updatedAt", until),
  );

  return { camp: hydratedCamp, classes, sessions, entryCaps, registrations };
}

function buildGateway(includeArchived: boolean): SyncGateway {
  return {
    discoverCamps,
    getCamp: (campId) => new LoggedQuery(Camp).get(campId),
    fetchCampData: fetchCampDataGateway((camp, watermark, until) =>
      fetchCampData(camp, watermark, until, includeArchived),
    ),
  };
}

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
  .option("--camp <id>", "Sync only this camp, bypassing discovery and the backoff check")
  .addOption(
    new Option(
      "--since <iso-date>",
      "Backfill: re-read this camp's registrations from this date instead of its stored watermark. Requires --camp.",
    ).argParser(parseSince),
  )
  .option(
    "--include-archived",
    "Backfill: fetch this camp's archived sessions too, instead of the scheduled sync's filter. Requires --camp.",
  )
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
      options: redactSecrets(action.opts()),
    });
  })
  .action(async (options) => {
    const validationError = validateBackfillOptions(options);
    if (validationError) {
      program.error(validationError);
    }

    const directus = new DirectusClient(options.directusUrl, options.directusToken, options.dryRun ?? false);
    const syncLog = new SyncLog(directus);
    const personSync = new PersonSync(directus);
    const gateway = buildGateway(options.includeArchived ?? false);

    const result = await runSync({
      clubId: options.club,
      ...(options.camp ? { campId: options.camp } : {}),
      ...(options.since ? { since: options.since } : {}),
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

// Guards the CLI run so tests can import this module - for `redactSecrets`, notably - without
// commander parsing the test runner's own argv and exiting the process out from under it.
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

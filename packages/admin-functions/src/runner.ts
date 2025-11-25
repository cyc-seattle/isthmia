import winston from "winston";
import { safeCall, SpreadsheetClient } from "@cyc-seattle/gsuite";
import { ReportConstructor } from "./reports.js";
import { GoogleSpreadsheetRow } from "google-spreadsheet";
import { CampsReport } from "./camps.js";
import { RegistrationsReport } from "./registrations.js";
import { SessionsReport } from "./sessions.js";
import { GoogleChatNotifier, NopNotifier } from "./notifications.js";
import { DateTime, Interval } from "luxon";
import { ParticipantsReport } from "./participants.js";
import { Auth } from "googleapis";
import { ContactReport } from "./contacts.js";

export const reports: Record<string, ReportConstructor> = {
  camps: CampsReport,
  participants: ParticipantsReport,
  registrations: RegistrationsReport,
  sessions: SessionsReport,
  contacts: ContactReport,
};

type ReportKeys = keyof typeof reports;

type ReportRow = {
  readonly report: ReportKeys;
  readonly arguments: string;
  readonly spreadsheetUrl: string;
  readonly sheet: string;
  readonly enabled: boolean;
  lastRun?: string;
  success: boolean;
  webhook: string;
};

function parseBoolean(input: string): boolean | undefined {
  try {
    return JSON.parse(input.toLowerCase());
  } catch {
    return undefined;
  }
}

const EPOCH = DateTime.fromSeconds(0);

function parseDate(input?: string): DateTime | undefined {
  if (input === undefined || input.length == 0) {
    return undefined;
  }

  const result = DateTime.fromISO(input);

  if (!result.isValid) {
    throw new Error(`Cannot parse ${input} as a DateTime`);
  }

  return result;
}

export class ReportRunner {
  private readonly spreadsheets: SpreadsheetClient;

  constructor(public readonly auth: Auth.GoogleApiAuth) {
    this.spreadsheets = new SpreadsheetClient(auth);
  }

  public async runRow(row: GoogleSpreadsheetRow<ReportRow>, now: DateTime) {
    const reportName = row.get("report");

    const reportClass = reports[reportName];
    if (reportClass === undefined) {
      throw new Error(`No report with the name ${reportName}`);
    }

    winston.info("Running report", row.toObject());
    const timer = winston.startTimer();

    const spreadsheet = await this.spreadsheets.loadSpreadsheet(row.get("spreadsheetUrl"));

    const webhook = row.get("webhook");
    const notifier = webhook === undefined ? new NopNotifier() : new GoogleChatNotifier({ url: webhook });

    // Run the report for the interval between the last time it ran successfully and now.
    // If it hasn't been run successfully, run the report from the beginning of time to now.
    const lastRun = parseDate(row.get("lastRun")) ?? EPOCH;
    const interval = Interval.fromDateTimes(lastRun, now);

    const report = new reportClass({
      arguments: row.get("arguments"),
      auth: this.auth,
      spreadsheet,
      sheetName: row.get("sheet"),
      interval,
      notifier,
    });

    await report.run();
    timer.done({ message: "Report successful", report: row.toObject() });
  }

  public async runAll(configSpreadsheetId: string) {
    const configSpreadsheet = await this.spreadsheets.loadSpreadsheet(configSpreadsheetId);
    const worksheet = await configSpreadsheet.getOrCreateWorksheet<ReportRow>("Reports", [
      "enabled",
      "report",
      "arguments",
      "spreadsheetUrl",
      "sheet",
      "lastRun",
      "success",
      "webhook",
    ]);

    for (const row of await worksheet.getRows()) {
      const enabled = parseBoolean(row.get("enabled"));
      if (!enabled) {
        winston.debug("Skipping row", { range: row.a1Range });
        continue;
      }

      const now = DateTime.now();
      const options = row.toObject();

      try {
        winston.debug("Processing row", { range: row.a1Range });
        await this.runRow(row, now);
        row.set("success", true);
        row.set("lastRun", now.toISO());
      } catch (err) {
        winston.error("Failed to run report", { options, err });
        row.set("success", false);
      }

      winston.debug("Saving row", { range: row.a1Range });
      await safeCall(() => row.save());
    }
  }
}

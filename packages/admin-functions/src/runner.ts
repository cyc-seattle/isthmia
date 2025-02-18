import winston from 'winston';
import { SpreadsheetClient } from './spreadsheets.js';
import { ReportConstructor } from './reports.js';
import { GoogleSpreadsheetRow } from 'google-spreadsheet';
import { CampsReport } from './camps.js';
import { RegistrationsReport } from './registrations.js';
import { SessionsReport } from './sessions.js';

const reports: Record<string, ReportConstructor> = {
  camps: CampsReport,
  registrations: RegistrationsReport,
  sessions: SessionsReport,
};

type ReportKeys = keyof typeof reports;

interface RunReportOptions {
  readonly report: ReportKeys;
  readonly arguments: string;
  readonly spreadsheetUrl: string;
  readonly sheet: string;
}

interface ReportRow extends RunReportOptions {
  readonly enabled: boolean;
  lastRun: string;
  success: boolean;
}

function formatDateTime(date: Date) {
  const locale = 'en-US';
  const dateStr = date.toLocaleDateString(locale);
  const timeStr = date.toLocaleTimeString(locale);
  return `${dateStr} ${timeStr}`;
}

function parseBoolean(input: string): boolean | undefined {
  try {
    return JSON.parse(input.toLowerCase());
  } catch {
    return undefined;
  }
}

function debugRow(row: GoogleSpreadsheetRow) {
  return { range: row.a1Range, values: row.toObject() };
}

export class ReportRunner {
  constructor(private readonly spreadsheets: SpreadsheetClient) {}

  public async run(options: RunReportOptions) {
    const reportClass = reports[options.report];
    if (reportClass === undefined) {
      throw new Error(`No report with the name ${options.report}`);
    }

    winston.info('Running report', options);
    const spreadsheet = await this.spreadsheets.loadSpreadsheet(
      options.spreadsheetUrl,
    );
    const report = new reportClass(spreadsheet);
    await report.run(options.arguments, options.sheet);
  }

  public async runAll(configSpreadsheetId: string) {
    const configSpreadsheet =
      await this.spreadsheets.loadSpreadsheet(configSpreadsheetId);
    const reports = await configSpreadsheet.getOrCreateTable<ReportRow>(
      'Reports',
      [
        'enabled',
        'report',
        'arguments',
        'spreadsheetUrl',
        'sheet',
        'lastRun',
        'success',
      ],
    );

    for (const row of reports.rows) {
      winston.debug('Processing row', debugRow(row));
      const options: RunReportOptions = {
        report: row.get('report'),
        arguments: row.get('arguments'),
        spreadsheetUrl: row.get('spreadsheetUrl'),
        sheet: row.get('sheet'),
      };

      const enabled = parseBoolean(row.get('enabled'));
      if (!enabled) {
        winston.debug('Skipping row', { row: row.a1Range });
        continue;
      }

      try {
        await this.run(options);
        row.set('success', true);
      } catch (err) {
        winston.error('Failed to run report', { options, err });
        row.set('success', false);
      } finally {
        row.set('lastRun', formatDateTime(new Date()));
      }

      winston.debug('Saving row', { range: row.a1Range });
      await row.save();
    }
  }
}

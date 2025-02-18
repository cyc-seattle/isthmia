import {
  GoogleSpreadsheet,
  GoogleSpreadsheetRow,
  GoogleSpreadsheetWorksheet,
} from 'google-spreadsheet';
import { Auth } from 'googleapis';
import winston from 'winston';

export type Row = Record<string, any>;
export type RowKeys<T extends Row> = Extract<keyof T, string>[];

function extractSpreadsheetId(urlOrId: string) {
  const url = URL.parse(urlOrId);
  if (url) {
    const pathSegments = url.pathname.split('/');

    if (pathSegments.length < 4) {
      throw new Error(`Cannot extract spreadsheet id from ${urlOrId}`);
    }

    return pathSegments[3]!;
  }

  return urlOrId;
}

interface AddOrUpdateResult {
  readonly existing: boolean;
}

export class Table<T extends Row> {
  constructor(
    private readonly worksheet: GoogleSpreadsheetWorksheet,
    public readonly rows: GoogleSpreadsheetRow<T>[],
  ) {}

  public async addOrUpdate(
    predicate: (row: GoogleSpreadsheetRow<T>) => boolean,
    values: T,
  ): Promise<AddOrUpdateResult> {
    const existingRow = this.rows.find(predicate);

    if (existingRow === undefined) {
      winston.info('Adding row', values);
      await this.worksheet.addRow(values);
      return { existing: false };
    }

    winston.info('Updating row', { range: existingRow.a1Range, values });
    existingRow.assign(values);
    await existingRow.save();

    return { existing: true };
  }

  public static async fromWorksheet(worksheet: GoogleSpreadsheetWorksheet) {
    winston.debug('Loading worksheet rows', { title: worksheet.title });
    const rows = await worksheet.getRows();
    return new Table(worksheet, rows);
  }
}

export class TypedSpreadsheet extends GoogleSpreadsheet {
  public async getOrCreateTable<T extends Row>(
    title: string,
    headerValues: RowKeys<T>,
  ) {
    let worksheet = this.sheetsByTitle[title];

    if (worksheet === undefined) {
      winston.debug('Creating worksheet', { title, headerValues });
      worksheet = await this.addSheet({
        title: title,
        headerValues: headerValues,
        gridProperties: {
          rowCount: 1,
          columnCount: headerValues.length,
        },
      });
    }

    winston.debug('Opened worksheet', { title: worksheet.title });
    return Table.fromWorksheet(worksheet);
  }
}

export class SpreadsheetClient {
  constructor(public readonly auth: Auth.GoogleApiAuth) {}

  public async loadSpreadsheet(spreadsheetUrlOrId: string) {
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrlOrId);
    const spreadsheet = new TypedSpreadsheet(spreadsheetId, this.auth);

    await spreadsheet.loadInfo();
    winston.debug('Loaded spreadsheet', {
      spreadsheetId,
      title: spreadsheet.title,
    });

    return spreadsheet;
  }
}

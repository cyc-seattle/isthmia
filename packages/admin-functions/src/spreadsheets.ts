import {
  GoogleSpreadsheet,
  GoogleSpreadsheetCellErrorValue,
  GoogleSpreadsheetWorksheet,
} from 'google-spreadsheet';
import { Auth } from 'googleapis';
import winston from 'winston';
import { backOff } from 'exponential-backoff';
import { setTimeout } from 'timers/promises';

// The default quota on Google Spreadsheet API is 60 requests/minute/user.
// However, there's a separate read and write quote, so we can safely double
// this to get a little bit more throughput.
const requestPerMinute = 60 * 2;
const millisPerRequest = (60 * 1000) / requestPerMinute;

export async function safeCall<T>(request: () => Promise<T>): Promise<T> {
  await setTimeout(millisPerRequest);
  return backOff(request, {
    jitter: 'full',
    numOfAttempts: 2,
    startingDelay: 60_000,
    retry: () => {
      winston.warn('Request to Google Spreadsheets failed. Retrying');
      return true;
    },
  });
}

type RowValueType = number | boolean | string | Date | undefined;
type RowData = Array<number | boolean | string | Date>;
type CellValueType =
  | number
  | boolean
  | string
  | null
  | GoogleSpreadsheetCellErrorValue;

export type Row = Record<string, RowValueType>;
export type RowKeys<T extends Row> = Extract<keyof T, string>;
export type HeaderValues<T extends Row> = RowKeys<T>[];

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
  private readonly cellCache: CellValueType[][];
  private readonly addedRows: RowData[] = [];

  constructor(
    private readonly worksheet: GoogleSpreadsheetWorksheet,
    private readonly headerColumns: Map<string, number>,
  ) {
    this.cellCache = [];

    for (let row = 0; row < worksheet.rowCount; row++) {
      const values = [];
      for (let col = 0; col < worksheet.columnCount; col++) {
        values[col] = worksheet.getCell(row, col).value;
      }

      this.cellCache[row] = values;
    }
  }

  public getCellValue(header: RowKeys<T>, rowIndex: number) {
    const columnIndex = this.headerColumns.get(header);
    if (columnIndex === undefined) {
      return undefined;
    }
    return this.cellCache[rowIndex]?.[columnIndex];
  }

  /**
   * Finds the row index of the row containing the values in "needle". This object may be a partial record to only
   * match on key fields.
   */
  public findRowIndex(needle: Partial<T>) {
    const needleKeys = Object.keys(needle) as HeaderValues<T>;

    for (let row = 1; row < this.worksheet.rowCount; row++) {
      const found = needleKeys.every((header) => {
        const rowValue = this.getCellValue(header, row);
        const needleValue = needle[header];
        return rowValue === needleValue;
      });

      if (found) {
        return row;
      }
    }

    return undefined;
  }

  public updateRow(rowIndex: number, values: T) {
    winston.info('Updating existing row', { rowIndex, values });

    const headers = Object.keys(values);
    for (const header of headers) {
      const columnIndex = this.headerColumns.get(header);
      if (columnIndex !== undefined) {
        const cell = this.worksheet.getCell(rowIndex, columnIndex);
        const value = values[header];
        cell.value = value;
      }
    }
  }

  public addRow(values: T) {
    winston.info('Adding new row', { values });
    const newRow: RowData = [];

    const headers = Object.keys(values);
    for (const header of headers) {
      const columnIndex = this.headerColumns.get(header);
      if (columnIndex !== undefined) {
        newRow[columnIndex] = values[header] ?? '';
      }
    }

    this.addedRows.push(newRow);
  }

  public addOrUpdate(keys: HeaderValues<T>, values: T): AddOrUpdateResult {
    const needle = {} as Partial<T>;
    for (const key of keys) {
      needle[key] = values[key];
    }

    const rowIndex = this.findRowIndex(needle);
    if (rowIndex === undefined) {
      this.addRow(values);
      return { existing: false };
    } else {
      this.updateRow(rowIndex, values);
      return { existing: true };
    }
  }

  public async save() {
    winston.debug('Saving updated cells');
    await safeCall(() => this.worksheet.saveUpdatedCells());

    if (this.addedRows.length > 0) {
      winston.debug('Adding new rows', { count: this.addedRows.length });
      await safeCall(() => this.worksheet.addRows(this.addedRows));
    }
  }
}

export class Worksheet<T extends Row> {
  constructor(private readonly worksheet: GoogleSpreadsheetWorksheet) {}

  public async getRows() {
    return safeCall(() => this.worksheet.getRows<T>());
  }

  public async getTable() {
    winston.debug('Loading worksheet cells', { title: this.worksheet.title });
    await safeCall(() => this.worksheet.loadCells());
    winston.debug('Loaded worksheet cells', this.worksheet.cellStats);

    const headerColumns = new Map<string, number>();

    for (let col = 0; col < this.worksheet.columnCount; col++) {
      const cellValue = this.worksheet.getCell(0, col).stringValue;
      if (cellValue !== undefined) {
        headerColumns.set(cellValue, col);
      }
    }

    return new Table(this.worksheet, headerColumns);
  }
}

export class Spreadsheet extends GoogleSpreadsheet {
  private async createWorksheet<T extends Row>(
    title: string,
    headerValues: HeaderValues<T>,
  ) {
    winston.debug('Creating worksheet', { title, headerValues: headerValues });
    return safeCall(() =>
      this.addSheet({
        title: title,
        headerValues: headerValues,
        gridProperties: {
          rowCount: 1,
          columnCount: headerValues.length,
        },
      }),
    );
  }

  public async getOrCreateWorksheet<T extends Row>(
    title: string,
    headerValues: HeaderValues<T>,
  ) {
    const worksheet =
      this.sheetsByTitle[title] ??
      (await this.createWorksheet(title, headerValues));
    return new Worksheet<T>(worksheet);
  }
}

export class SpreadsheetClient {
  constructor(public readonly auth: Auth.GoogleApiAuth) {}

  public async loadSpreadsheet(spreadsheetUrlOrId: string) {
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrlOrId);
    const spreadsheet = new Spreadsheet(spreadsheetId, this.auth);

    await safeCall(() => spreadsheet.loadInfo());
    winston.debug('Loaded spreadsheet', {
      spreadsheetId,
      title: spreadsheet.title,
      locale: spreadsheet.locale,
      timeZone: spreadsheet.timeZone,
    });

    return spreadsheet;
  }
}

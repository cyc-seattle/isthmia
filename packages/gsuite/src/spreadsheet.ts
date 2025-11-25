import { GoogleSpreadsheet, GoogleSpreadsheetCellErrorValue, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { Auth } from "googleapis";
import winston from "winston";
import { safeCall } from "./common.js";

type RowValueType = number | boolean | string | Date | undefined;
type RowData = Array<number | boolean | string | Date>;
type CellValueType = number | boolean | string | null | GoogleSpreadsheetCellErrorValue;

export type Row = Record<string, RowValueType>;
export type RowKeys<T extends Row> = Extract<keyof T, string>;
export type HeaderValues<T extends Row> = RowKeys<T>[];

interface AddOrUpdateResult {
  readonly existing: boolean;
}

/**
 * Represents a table in a Google Spreadsheet with cached cell access
 */
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
   * Finds all rows (by index) containing the values in "needle". This object may be a partial record to only
   * match on key fields.
   */
  public findRows(needle: Partial<T>) {
    const rows = [];
    const needleKeys = Object.keys(needle) as HeaderValues<T>;

    for (let row = 1; row < this.worksheet.rowCount; row++) {
      const found = needleKeys.every((header) => {
        const rowValue = this.getCellValue(header, row);
        const needleValue = needle[header];
        return rowValue === needleValue;
      });

      if (found) {
        rows.push(row);
      }
    }

    return rows;
  }

  public updateRow(rowIndex: number, values: Partial<T>) {
    winston.info("Updating existing row", { rowIndex, values });

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

  public addRow(values: Partial<T>) {
    winston.info("Adding new row", { values });
    const newRow: RowData = [];

    const headers = Object.keys(values);
    for (const header of headers) {
      const columnIndex = this.headerColumns.get(header);
      if (columnIndex !== undefined) {
        newRow[columnIndex] = values[header] ?? "";
      }
    }

    this.addedRows.push(newRow);
  }

  public updateRows(keys: HeaderValues<T>, values: Partial<T>) {
    const needle = {} as Partial<T>;
    for (const key of keys) {
      needle[key] = values[key];
    }

    const rows = this.findRows(needle);
    for (const rowIndex of rows) {
      this.updateRow(rowIndex, values);
    }
  }

  /**
   * Updates ALL rows where the key columns matched the supplied values, or if
   * no such rows exist, adds a new one.
   */
  public addOrUpdate(keys: HeaderValues<T>, values: Partial<T>): AddOrUpdateResult {
    const needle = {} as Partial<T>;
    for (const key of keys) {
      needle[key] = values[key];
    }

    const rows = this.findRows(needle);
    if (rows.length == 0) {
      this.addRow(values);
      return { existing: false };
    } else {
      for (const rowIndex of rows) {
        this.updateRow(rowIndex, values);
      }
      return { existing: true };
    }
  }

  public async save(reload?: boolean) {
    winston.debug("Saving updated cells");
    await safeCall(() => this.worksheet.saveUpdatedCells());

    if (this.addedRows.length > 0) {
      winston.debug("Adding new rows", { count: this.addedRows.length });
      await safeCall(() => this.worksheet.addRows(this.addedRows));
    }

    if (reload) {
      await safeCall(() => this.worksheet.loadCells());
    }
  }
}

/**
 * Represents a worksheet in a Google Spreadsheet
 */
export class Worksheet<T extends Row> {
  constructor(private readonly worksheet: GoogleSpreadsheetWorksheet) {}

  public async getRows() {
    return safeCall(() => this.worksheet.getRows<T>());
  }

  public async getTable(): Promise<Table<T>> {
    winston.debug("Loading worksheet cells", { title: this.worksheet.title });
    await safeCall(() => this.worksheet.loadCells());
    winston.debug("Loaded worksheet cells", this.worksheet.cellStats);

    const headerColumns = new Map<string, number>();

    for (let col = 0; col < this.worksheet.columnCount; col++) {
      const cellValue = this.worksheet.getCell(0, col).stringValue;
      if (cellValue !== undefined) {
        headerColumns.set(cellValue, col);
      }
    }

    return new Table<T>(this.worksheet, headerColumns);
  }
}

/**
 * Extended GoogleSpreadsheet with helper methods
 */
export class Spreadsheet extends GoogleSpreadsheet {
  private async createWorksheet<T extends Row>(title: string, headerValues: HeaderValues<T>) {
    winston.debug("Creating worksheet", { title, headerValues: headerValues });
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

  public async getOrCreateWorksheet<T extends Row>(title: string, headerValues: HeaderValues<T>) {
    const worksheet = this.sheetsByTitle[title] ?? (await this.createWorksheet(title, headerValues));
    return new Worksheet<T>(worksheet);
  }
}

/**
 * Extracts spreadsheet ID from a URL or returns the ID as-is
 */
function extractSpreadsheetId(urlOrId: string): string {
  try {
    const url = new URL(urlOrId);
    const pathSegments = url.pathname.split("/");

    if (pathSegments.length < 4) {
      throw new Error(`Cannot extract spreadsheet ID from ${urlOrId}`);
    }

    return pathSegments[3]!;
  } catch {
    // If it's not a valid URL, assume it's already an ID
    return urlOrId;
  }
}

/**
 * Client for loading Google Spreadsheets
 */
export class SpreadsheetClient {
  constructor(private readonly auth: Auth.GoogleAuth) {}

  public async loadSpreadsheet(spreadsheetUrlOrId: string) {
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrlOrId);
    const spreadsheet = new Spreadsheet(spreadsheetId, this.auth);

    await safeCall(() => spreadsheet.loadInfo());
    winston.debug("Loaded spreadsheet", {
      spreadsheetId,
      title: spreadsheet.title,
      locale: spreadsheet.locale,
      timeZone: spreadsheet.timeZone,
    });

    return spreadsheet;
  }
}

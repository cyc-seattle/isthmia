import { GoogleSpreadsheet, GoogleSpreadsheetCellErrorValue, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { Auth, drive_v3, google, sheets_v4 } from "googleapis";
import winston from "winston";
import { safeCall } from "./common.js";

type RowValueType = number | boolean | string | Date | undefined;
type RowData = Array<number | boolean | string | Date>;
type CachedValue = number | boolean | string | Date | null | GoogleSpreadsheetCellErrorValue;

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
  private readonly addedRows: RowData[] = [];

  // Cell values keyed by "row,col", populated lazily on read and kept in sync on
  // write. google-spreadsheet's `cell.value` getter throws "Value has been changed"
  // once a cell has been assigned but not yet saved, so findRows must never re-read
  // a cell that an earlier updateRow modified. Caching the value we read (or wrote)
  // avoids touching the live getter a second time.
  private readonly valueCache = new Map<string, CachedValue>();

  constructor(
    private readonly worksheet: GoogleSpreadsheetWorksheet,
    private readonly headerColumns: Map<string, number>,
  ) {}

  private cacheKey(rowIndex: number, columnIndex: number) {
    return `${rowIndex},${columnIndex}`;
  }

  public getCellValue(header: RowKeys<T>, rowIndex: number) {
    const columnIndex = this.headerColumns.get(header);
    if (columnIndex === undefined) {
      return undefined;
    }

    const key = this.cacheKey(rowIndex, columnIndex);
    if (this.valueCache.has(key)) {
      return this.valueCache.get(key);
    }

    // Safe to read the live cell here: it has not been modified this session.
    const value = this.worksheet.getCell(rowIndex, columnIndex).value;
    this.valueCache.set(key, value);
    return value;
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
        // Keep the cache consistent with the write so later reads don't hit the
        // now-dirty cell's throwing getter and so findRows reflects the update.
        this.valueCache.set(this.cacheKey(rowIndex, columnIndex), value ?? null);
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

  /** The numeric sheet id, needed to target this worksheet in raw Sheets API requests. */
  public get sheetId() {
    return this.worksheet.sheetId;
  }

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

  /**
   * Adds a worksheet with the given headers, returning the typed wrapper. Unlike
   * {@link getOrCreateWorksheet}, this always creates a new sheet (used when building a
   * fresh spreadsheet where each tab is written once).
   */
  public async addWorksheet<T extends Row>(title: string, headerValues: HeaderValues<T>) {
    const worksheet = await this.createWorksheet(title, headerValues);
    return new Worksheet<T>(worksheet);
  }

  /** Deletes the worksheet with the given title, if it exists. */
  public async deleteWorksheet(title: string) {
    const worksheet = this.sheetsByTitle[title];
    if (worksheet !== undefined) {
      await safeCall(() => worksheet.delete());
    }
  }

  /**
   * Clears every existing worksheet so the spreadsheet can be rebuilt from scratch,
   * leaving a single empty placeholder sheet (a spreadsheet must always have ≥1 sheet).
   * The placeholder is created first so it survives while the originals are deleted, and
   * its title is returned so the caller can remove it after adding the real sheets.
   */
  public async resetSheets(): Promise<string> {
    const placeholderTitle = `_rebuild_${Date.now()}`;
    const existing = [...this.sheetsByIndex];
    await safeCall(() => this.addSheet({ title: placeholderTitle, gridProperties: { rowCount: 1, columnCount: 1 } }));
    for (const worksheet of existing) {
      await safeCall(() => worksheet.delete());
    }
    return placeholderTitle;
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

  /**
   * Creates a new, empty Google Spreadsheet inside the given Drive folder and returns it
   * loaded and ready to write.
   *
   * The Drive API is used (rather than google-spreadsheet's createNewSpreadsheetDocument,
   * which only lands the file in "My Drive") so the file can be parented directly in a
   * folder. `supportsAllDrives` is required because our target folders live in shared
   * drives. Requires the `drive` OAuth scope.
   */
  public async createSpreadsheet(title: string, folderId: string) {
    const drive: drive_v3.Drive = google.drive("v3");

    const file = await safeCall<drive_v3.Schema$File>(async () => {
      const response = await drive.files.create({
        auth: this.auth,
        requestBody: {
          name: title,
          mimeType: "application/vnd.google-apps.spreadsheet",
          parents: [folderId],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      return response.data;
    });

    const spreadsheetId = file.id;
    if (!spreadsheetId) {
      throw new Error(`Drive did not return an id for the new spreadsheet "${title}"`);
    }

    winston.info("Created spreadsheet", { title, spreadsheetId, folderId });
    return this.loadSpreadsheet(spreadsheetId);
  }

  /**
   * Finds the id of a non-trashed spreadsheet with the exact given name inside the folder,
   * or undefined if none exists. `supportsAllDrives` / `includeItemsFromAllDrives` are set
   * because our folders live in shared drives.
   */
  public async findSpreadsheetInFolder(title: string, folderId: string): Promise<string | undefined> {
    const drive: drive_v3.Drive = google.drive("v3");
    const escapedTitle = title.replace(/'/g, "\\'");

    const fileList = await safeCall<drive_v3.Schema$FileList>(async () => {
      const response = await drive.files.list({
        auth: this.auth,
        q: `name = '${escapedTitle}' and '${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: "files(id,name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1,
      });
      return response.data;
    });

    return fileList.files?.[0]?.id ?? undefined;
  }

  /**
   * Returns a spreadsheet named `title` in the folder, ready to be rebuilt: if one already
   * exists it is reused (and its sheets cleared) so the file id / URL stays stable across
   * runs; otherwise a new one is created. The returned `placeholderTitle` is a throwaway
   * sheet the caller should delete after adding the real worksheets.
   */
  public async getOrCreateSpreadsheet(
    title: string,
    folderId: string,
  ): Promise<{ spreadsheet: Spreadsheet; placeholderTitle: string; reused: boolean }> {
    const existingId = await this.findSpreadsheetInFolder(title, folderId);
    if (existingId !== undefined) {
      winston.info("Reusing existing spreadsheet", { title, spreadsheetId: existingId });
      const spreadsheet = await this.loadSpreadsheet(existingId);
      const placeholderTitle = await spreadsheet.resetSheets();
      return { spreadsheet, placeholderTitle, reused: true };
    }

    const spreadsheet = await this.createSpreadsheet(title, folderId);
    return { spreadsheet, placeholderTitle: "Sheet1", reused: false };
  }

  /**
   * Applies raw Sheets API requests (formatting, banding, borders, etc.) that the
   * google-spreadsheet abstraction doesn't expose. Requests are sent as a single atomic
   * batchUpdate.
   */
  public async batchUpdate(spreadsheetId: string, requests: sheets_v4.Schema$Request[]) {
    if (requests.length === 0) {
      return;
    }
    const sheets: sheets_v4.Sheets = google.sheets("v4");
    await safeCall(() =>
      sheets.spreadsheets.batchUpdate({
        auth: this.auth,
        spreadsheetId,
        requestBody: { requests },
      }),
    );
  }

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

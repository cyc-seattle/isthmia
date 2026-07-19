import { Camp, CampSession, LoggedQuery, queryCampEntries, Registration } from "@cyc-seattle/clubspot-sdk";
import { Row, SpreadsheetClient } from "@cyc-seattle/gsuite";
import { Auth, sheets_v4 } from "googleapis";
import { DateTime } from "luxon";
import winston from "winston";

/** Leading columns on a class's Sign-In tab, before the per-day check-in/out boxes. */
export const SIGNIN_LEADING_HEADERS = ["First Name", "Last Name", "Age"] as const;
/** Trailing columns on a class's Sign-In tab, after the per-day boxes. */
export const SIGNIN_TRAILING_HEADERS = ["Emergency Contact", "Emergency Mobile", "Notes"] as const;

export const MEDICAL_HEADERS = [
  "First Name",
  "Last Name",
  "Age",
  "Allergies",
  "Medical Details",
  "Medication",
  "Last Tetanus Shot",
  "Emergency Contact",
  "Emergency Mobile",
  "Notes",
] as const;

/** A single camper on the roster, already scoped to one class for the target week. */
export interface RosterEntry {
  className: string;
  firstName: string;
  lastName: string;
  age: number | undefined;
  allergies: string | undefined;
  medical: string | undefined;
  medication: string | undefined;
  tetanus: string | undefined;
  emergencyContact: string | undefined;
  emergencyMobile: string | undefined;
}

/**
 * Whole years between a date of birth and the reference date (the session start). Camp
 * age is taken "at camp" rather than as-of-today so a roster generated weeks early still
 * shows the age the camper will be during the session. Clubspot dates are UTC.
 */
export function calculateAge(dob: Date | undefined, asOf: DateTime): number | undefined {
  if (dob === undefined) {
    return undefined;
  }
  const birth = DateTime.fromJSDate(dob, { zone: "utc" });
  const years = asOf.diff(birth, "years").years;
  return Math.floor(years);
}

/**
 * Builds the per-day check-in / sign-out column headers for the Monday–Friday of a camp
 * week (e.g. "Mon In", "Mon Out"). The week is identified by the spreadsheet title, so the
 * columns show only the weekday, keeping the boxes narrow.
 */
export function dailyColumnHeaders(sessionStart: DateTime): string[] {
  const headers: string[] = [];
  for (let day = 0; day < 5; day++) {
    const label = sessionStart.plus({ days: day }).toFormat("EEE");
    headers.push(`${label} In`, `${label} Out`);
  }
  return headers;
}

/**
 * Turns confirmed camp registrations into roster entries scoped to a single session
 * (week). One entry is produced per camper × class, so a camper enrolled in two classes
 * that week appears once under each class. Cancelled registrations and waitlisted
 * session joins are excluded. Entries are sorted by class, then last/first name.
 */
export function buildRosterEntries(
  registrations: Registration[],
  sessionId: string,
  sessionStart: DateTime,
): RosterEntry[] {
  const entries: RosterEntry[] = [];

  for (const registration of registrations) {
    if (registration.get("archived") ?? false) {
      continue;
    }

    const sessionJoins = (registration.get("sessionJoinObjects") ?? []).filter((join) => {
      const forThisSession = join.get("campSessionObject")?.id === sessionId;
      const active = !(join.get("waitlist") ?? false) && !(join.get("archived") ?? false);
      return forThisSession && active;
    });

    if (sessionJoins.length === 0) {
      continue;
    }

    for (const participant of registration.get("participantsArray") ?? []) {
      const firstName = (participant.get("firstName") ?? registration.get("firstName") ?? "").trim();
      const lastName = (participant.get("lastName") ?? registration.get("lastName") ?? "").trim();
      const age = calculateAge(participant.get("DOB"), sessionStart);

      for (const join of sessionJoins) {
        entries.push({
          className: join.get("campClassObject")?.get("name") ?? "",
          firstName,
          lastName,
          age,
          allergies: participant.get("medical_allergies"),
          medical: participant.get("medical"),
          medication: participant.get("medical_meds"),
          tetanus: participant.get("medical_tetanus"),
          emergencyContact: participant.get("emergencyContact"),
          emergencyMobile: participant.get("emergencyMobile"),
        });
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.className.localeCompare(b.className) ||
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );

  return entries;
}

/** Groups sorted roster entries by class name, preserving class order. */
export function groupByClass(entries: RosterEntry[]): Map<string, RosterEntry[]> {
  const byClass = new Map<string, RosterEntry[]>();
  for (const entry of entries) {
    const existing = byClass.get(entry.className);
    if (existing === undefined) {
      byClass.set(entry.className, [entry]);
    } else {
      existing.push(entry);
    }
  }
  return byClass;
}

function signInRow(entry: RosterEntry): Row {
  return {
    "First Name": entry.firstName,
    "Last Name": entry.lastName,
    Age: entry.age,
    "Emergency Contact": entry.emergencyContact,
    "Emergency Mobile": entry.emergencyMobile,
    // Daily In/Out boxes and Notes are intentionally left blank for staff to fill in.
  };
}

function medicalRow(entry: RosterEntry): Row {
  return {
    "First Name": entry.firstName,
    "Last Name": entry.lastName,
    Age: entry.age,
    Allergies: entry.allergies,
    "Medical Details": entry.medical,
    Medication: entry.medication,
    "Last Tetanus Shot": entry.tetanus,
    "Emergency Contact": entry.emergencyContact,
    "Emergency Mobile": entry.emergencyMobile,
  };
}

const HEADER_COLOR: sheets_v4.Schema$Color = { red: 0.2, green: 0.4, blue: 0.6 };
const BAND_COLOR: sheets_v4.Schema$Color = { red: 0.93, green: 0.95, blue: 0.98 };
const WHITE: sheets_v4.Schema$Color = { red: 1, green: 1, blue: 1 };
const BORDER: sheets_v4.Schema$Border = { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } };

/** A fixed pixel width applied to a span of columns, overriding auto-sizing. */
export interface ColumnWidth {
  startIndex: number;
  endIndex: number;
  pixelSize: number;
}

/**
 * Forces a consistent line break in two-word headers (e.g. "Tue In" → "Tue\nIn") so the
 * narrow columns all wrap the same way instead of some fitting on one line. Headers with
 * one word or three-plus words are left untouched.
 */
export function breakHeader(header: string): string {
  const words = header.split(" ");
  return words.length === 2 ? words.join("\n") : header;
}

export interface SheetFormatting {
  sheetId: number;
  headers: readonly string[];
  /** Number of data rows (excluding the column-header row). */
  dataRows: number;
  /** Row index of the column-header row (rows above it are the title block). */
  headerRowIndex?: number;
  /** Explicit column widths, applied after auto-sizing so they win. */
  columnWidths?: ColumnWidth[];
  /** Height (px) for the data rows. */
  dataRowHeight?: number;
}

/**
 * "Clean but simple" formatting for one worksheet: frozen header, a bold colored header
 * row with forced two-word line breaks, alternating row shading (banding), light borders
 * on the table, auto-sized columns with fixed-width overrides, and a data-row height. The
 * table's column-header row may sit below a title block (see {@link headerRowIndex}).
 */
export function sheetFormattingRequests(formatting: SheetFormatting): sheets_v4.Schema$Request[] {
  const { sheetId, headers, dataRows, columnWidths = [], dataRowHeight } = formatting;
  const headerRowIndex = formatting.headerRowIndex ?? 0;
  const numColumns = headers.length;
  const firstDataRow = headerRowIndex + 1;
  const endRow = firstDataRow + dataRows;

  const tableRange: sheets_v4.Schema$GridRange = {
    sheetId,
    startRowIndex: headerRowIndex,
    endRowIndex: endRow,
    startColumnIndex: 0,
    endColumnIndex: numColumns,
  };

  const requests: sheets_v4.Schema$Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: headerRowIndex + 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    // Rewrite the header cells with forced two-word line breaks (data was written with the
    // plain header text, so this only changes the displayed labels).
    {
      updateCells: {
        rows: [{ values: headers.map((h) => ({ userEnteredValue: { stringValue: breakHeader(h) } })) }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: headerRowIndex, columnIndex: 0 },
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: headerRowIndex, endRowIndex: headerRowIndex + 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: WHITE },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
      },
    },
    {
      addBanding: {
        bandedRange: {
          range: tableRange,
          rowProperties: { headerColor: HEADER_COLOR, firstBandColor: WHITE, secondBandColor: BAND_COLOR },
        },
      },
    },
    {
      updateBorders: {
        range: tableRange,
        top: BORDER,
        bottom: BORDER,
        left: BORDER,
        right: BORDER,
        innerHorizontal: BORDER,
        innerVertical: BORDER,
      },
    },
    // Auto-size everything first; explicit widths below override specific columns.
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: numColumns },
      },
    },
  ];

  for (const { startIndex, endIndex, pixelSize } of columnWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    });
  }

  if (dataRowHeight !== undefined && dataRows > 0) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: firstDataRow, endIndex: endRow },
        properties: { pixelSize: dataRowHeight },
        fields: "pixelSize",
      },
    });
  }

  return requests;
}

/** Number of rows in the title block above each tab's table (title + instructor line). */
export const TITLE_ROWS = 2;

/**
 * Requests that insert a title block at the top of a sheet: a merged, bold title row
 * (class + session) and an "Instructor:" line with a blank area to write in. Must run
 * before {@link sheetFormattingRequests}, which expects the table to start at
 * {@link TITLE_ROWS}.
 */
export function titleBlockRequests(sheetId: number, title: string, numColumns: number): sheets_v4.Schema$Request[] {
  return [
    {
      insertDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: TITLE_ROWS },
        inheritFromBefore: false,
      },
    },
    {
      updateCells: {
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: title },
                userEnteredFormat: { textFormat: { bold: true, fontSize: 14 }, horizontalAlignment: "CENTER" },
              },
            ],
          },
          {
            values: [
              {
                userEnteredValue: { stringValue: "Instructor:" },
                userEnteredFormat: { textFormat: { bold: true } },
              },
            ],
          },
        ],
        fields: "userEnteredValue,userEnteredFormat(textFormat,horizontalAlignment)",
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
      },
    },
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numColumns },
        mergeType: "MERGE_ALL",
      },
    },
    {
      // Merge the whole instructor row (including column 0) so the "Instructor:" label spans
      // the full width and doesn't force the First Name column wide during auto-sizing.
      mergeCells: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: numColumns },
        mergeType: "MERGE_ALL",
      },
    },
  ];
}

// Column widths / row height for the roster tabs, in pixels.
const AGE_WIDTH = 55; // slightly wider than the auto-fit of a 1–2 digit number
const DAILY_BOX_WIDTH = 45; // narrow In/Out check boxes
const NOTES_WIDTH = 110; // roomier free-text notes column
const DATA_ROW_HEIGHT = 42; // ~2× the default row height

export interface RosterOptions {
  readonly auth: Auth.GoogleAuth;
  readonly campId: string;
  /** A session (week) id, or a case-insensitive match on the session name. */
  readonly session: string;
  readonly folderId: string;
}

export class RosterGenerator {
  private readonly spreadsheets: SpreadsheetClient;

  constructor(private readonly options: RosterOptions) {
    this.spreadsheets = new SpreadsheetClient(options.auth);
  }

  private async resolveSession(camp: Camp): Promise<CampSession> {
    const sessions = await new LoggedQuery(CampSession).equalTo("campObject", camp).notEqualTo("archived", true).find();

    const selector = this.options.session;
    const lower = selector.toLowerCase();
    const session =
      sessions.find((s) => s.id === selector) ??
      sessions.find((s) => s.get("name")?.toLowerCase() === lower) ??
      sessions.find((s) => s.get("name")?.toLowerCase().includes(lower));

    if (session === undefined) {
      const available = sessions.map((s) => s.get("name")).join(", ");
      throw new Error(`No session matching "${selector}" in this camp. Available sessions: ${available}`);
    }

    return session;
  }

  public async generate(): Promise<string> {
    const camp = await new LoggedQuery(Camp).get(this.options.campId);
    const campName = camp.get("name");
    winston.info("Generating roster", { campId: this.options.campId, campName });

    const session = await this.resolveSession(camp);
    const sessionName = session.get("name");
    const sessionStart = DateTime.fromJSDate(session.get("startDate"), { zone: "utc" });
    winston.info("Resolved session", { sessionId: session.id, sessionName });

    const registrations = await queryCampEntries(camp).limit(1000).find();
    const entries = buildRosterEntries(registrations, session.id, sessionStart);
    const byClass = groupByClass(entries);
    winston.info("Built roster entries", { total: entries.length, classes: byClass.size });

    const title = `${campName} — ${sessionName} — Roster`;
    // Reuse an existing roster of the same name so the file URL stays stable across runs.
    const { spreadsheet, placeholderTitle, reused } = await this.spreadsheets.getOrCreateSpreadsheet(
      title,
      this.options.folderId,
    );
    winston.info(reused ? "Updating existing roster" : "Creating new roster", { title });

    const dailyHeaders = dailyColumnHeaders(sessionStart);
    const signInHeaders = [...SIGNIN_LEADING_HEADERS, ...dailyHeaders, ...SIGNIN_TRAILING_HEADERS];

    // Fixed-width overrides, keyed off column position. Age is at index 2 on both tabs.
    const ageWidth: ColumnWidth = { startIndex: 2, endIndex: 3, pixelSize: AGE_WIDTH };
    const dailyStart = SIGNIN_LEADING_HEADERS.length;
    const signInColumnWidths: ColumnWidth[] = [
      ageWidth,
      { startIndex: dailyStart, endIndex: dailyStart + dailyHeaders.length, pixelSize: DAILY_BOX_WIDTH },
      { startIndex: signInHeaders.length - 1, endIndex: signInHeaders.length, pixelSize: NOTES_WIDTH },
    ];
    // Medical tab: widen Age and the trailing Notes column.
    const medicalColumnWidths: ColumnWidth[] = [
      ageWidth,
      { startIndex: MEDICAL_HEADERS.length - 1, endIndex: MEDICAL_HEADERS.length, pixelSize: NOTES_WIDTH },
    ];

    const requests: sheets_v4.Schema$Request[] = [];

    // One Sign-In tab and one Medical tab per class, in sorted class order. Each tab gets a
    // title block (class + session + instructor line) above the table.
    for (const [className, classEntries] of byClass) {
      const tabTitle = `${className} — ${sessionName}`;

      const signInWorksheet = await spreadsheet.addWorksheet(`${className} — Sign-In`, signInHeaders);
      const signInTable = await signInWorksheet.getTable();
      for (const entry of classEntries) {
        signInTable.addRow(signInRow(entry));
      }
      await signInTable.save();
      requests.push(
        ...titleBlockRequests(signInWorksheet.sheetId, tabTitle, signInHeaders.length),
        ...sheetFormattingRequests({
          sheetId: signInWorksheet.sheetId,
          headers: signInHeaders,
          dataRows: classEntries.length,
          headerRowIndex: TITLE_ROWS,
          columnWidths: signInColumnWidths,
          dataRowHeight: DATA_ROW_HEIGHT,
        }),
      );

      const medicalWorksheet = await spreadsheet.addWorksheet(`${className} — Medical`, [...MEDICAL_HEADERS]);
      const medicalTable = await medicalWorksheet.getTable();
      for (const entry of classEntries) {
        medicalTable.addRow(medicalRow(entry));
      }
      await medicalTable.save();
      requests.push(
        ...titleBlockRequests(medicalWorksheet.sheetId, tabTitle, MEDICAL_HEADERS.length),
        ...sheetFormattingRequests({
          sheetId: medicalWorksheet.sheetId,
          headers: MEDICAL_HEADERS,
          dataRows: classEntries.length,
          headerRowIndex: TITLE_ROWS,
          columnWidths: medicalColumnWidths,
          dataRowHeight: DATA_ROW_HEIGHT,
        }),
      );
    }

    // Only remove the placeholder once real tabs exist (a spreadsheet needs ≥1 sheet).
    if (byClass.size > 0) {
      await spreadsheet.deleteWorksheet(placeholderTitle);
    }

    await this.spreadsheets.batchUpdate(spreadsheet.spreadsheetId, requests);

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}`;
    winston.info("Roster generated", { title, url });
    return url;
  }
}

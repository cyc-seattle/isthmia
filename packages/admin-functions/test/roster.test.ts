import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import type { Registration } from "@cyc-seattle/clubspot-sdk";
import {
  breakHeader,
  buildRosterEntries,
  calculateAge,
  dailyColumnHeaders,
  groupByClass,
  MEDICAL_HEADERS,
  sheetFormattingRequests,
  SIGNIN_LEADING_HEADERS,
  SIGNIN_TRAILING_HEADERS,
  TITLE_ROWS,
  titleBlockRequests,
} from "../src/roster.js";

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

interface JoinOpts {
  waitlist?: boolean;
  archived?: boolean;
}

function sessionJoin(sessionId: string, className: string, opts: JoinOpts = {}) {
  return parseObject(`${sessionId}-${className}`, {
    campSessionObject: { id: sessionId },
    campClassObject: parseObject(`class-${className}`, { name: className }),
    waitlist: opts.waitlist ?? false,
    archived: opts.archived ?? false,
  });
}

function participant(firstName: string, lastName: string, data: Record<string, unknown> = {}) {
  return parseObject(`p-${firstName}`, { firstName, lastName, ...data });
}

function registration(id: string, data: Record<string, unknown>) {
  return parseObject(id, { archived: false, ...data });
}

// Fixed reference Monday for the camp week.
const SESSION_START = DateTime.fromISO("2025-06-30", { zone: "utc" });

function build(registrations: unknown[]) {
  return buildRosterEntries(registrations as unknown as Registration[], "s1", SESSION_START);
}

describe("calculateAge", () => {
  it("floors to whole years at the session start", () => {
    expect(calculateAge(new Date("2015-07-01T00:00:00Z"), SESSION_START)).toBe(9);
  });

  it("counts a birthday landing exactly on the session start", () => {
    expect(calculateAge(new Date("2015-06-30T00:00:00Z"), SESSION_START)).toBe(10);
  });

  it("returns undefined when the date of birth is missing", () => {
    expect(calculateAge(undefined, SESSION_START)).toBeUndefined();
  });
});

describe("dailyColumnHeaders", () => {
  it("produces Mon–Fri In/Out columns labeled by weekday only (no date)", () => {
    const headers = dailyColumnHeaders(SESSION_START);
    expect(headers).toHaveLength(10);
    expect(headers[0]).toBe("Mon In");
    expect(headers[1]).toBe("Mon Out");
    expect(headers[8]).toBe("Fri In");
    expect(headers[9]).toBe("Fri Out");
  });
});

describe("header sets", () => {
  it("keeps the expected Sign-In leading/trailing columns (no Class column on per-class tabs)", () => {
    expect(SIGNIN_LEADING_HEADERS).toEqual(["First Name", "Last Name", "Age"]);
    expect(SIGNIN_TRAILING_HEADERS).toEqual(["Emergency Contact", "Emergency Mobile", "Notes"]);
  });

  it("keeps the expected Medical columns, including a blank Notes column", () => {
    expect(MEDICAL_HEADERS).toEqual([
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
    ]);
  });
});

describe("buildRosterEntries", () => {
  it("fans a camper out to one entry per class in the session", () => {
    const camper = participant("Amy", "Zeta", {
      DOB: new Date("2015-07-01T00:00:00Z"),
      medical_allergies: "Peanuts",
      emergencyContact: "Mom",
      emergencyMobile: "555",
    });
    const reg = registration("r1", {
      participantsArray: [camper],
      sessionJoinObjects: [sessionJoin("s1", "Guppies"), sessionJoin("s1", "Youth Beginner")],
    });

    const entries = build([reg]);

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.className)).toEqual(["Guppies", "Youth Beginner"]);
    expect(entries[0]).toMatchObject({
      firstName: "Amy",
      lastName: "Zeta",
      age: 9,
      allergies: "Peanuts",
      emergencyContact: "Mom",
    });
  });

  it("excludes waitlisted session joins", () => {
    const reg = registration("r1", {
      participantsArray: [participant("Bob", "Young")],
      sessionJoinObjects: [sessionJoin("s1", "Guppies", { waitlist: true })],
    });

    expect(build([reg])).toHaveLength(0);
  });

  it("excludes cancelled (archived) registrations", () => {
    const reg = registration("r1", {
      archived: true,
      participantsArray: [participant("Cara", "Young")],
      sessionJoinObjects: [sessionJoin("s1", "Guppies")],
    });

    expect(build([reg])).toHaveLength(0);
  });

  it("excludes joins for other sessions", () => {
    const reg = registration("r1", {
      participantsArray: [participant("Dan", "Young")],
      sessionJoinObjects: [sessionJoin("s2", "Guppies")],
    });

    expect(build([reg])).toHaveLength(0);
  });

  it("sorts by class, then last name, then first name", () => {
    const regs = [
      registration("r1", {
        participantsArray: [participant("Zoe", "Adams")],
        sessionJoinObjects: [sessionJoin("s1", "Youth Beginner")],
      }),
      registration("r2", {
        participantsArray: [participant("Amy", "Baker")],
        sessionJoinObjects: [sessionJoin("s1", "Guppies")],
      }),
      registration("r3", {
        participantsArray: [participant("Bea", "Baker")],
        sessionJoinObjects: [sessionJoin("s1", "Guppies")],
      }),
    ];

    const entries = build(regs);

    expect(entries.map((e) => `${e.className}/${e.lastName}/${e.firstName}`)).toEqual([
      "Guppies/Baker/Amy",
      "Guppies/Baker/Bea",
      "Youth Beginner/Adams/Zoe",
    ]);
  });
});

describe("groupByClass", () => {
  it("groups entries by class in class order, preserving row order within a class", () => {
    const regs = [
      registration("r1", {
        participantsArray: [participant("Amy", "Baker")],
        sessionJoinObjects: [sessionJoin("s1", "Guppies")],
      }),
      registration("r2", {
        participantsArray: [participant("Zoe", "Adams")],
        sessionJoinObjects: [sessionJoin("s1", "Youth Beginner")],
      }),
      registration("r3", {
        participantsArray: [participant("Bea", "Baker")],
        sessionJoinObjects: [sessionJoin("s1", "Guppies")],
      }),
    ];

    const grouped = groupByClass(build(regs));

    expect([...grouped.keys()]).toEqual(["Guppies", "Youth Beginner"]);
    expect(grouped.get("Guppies")?.map((e) => e.firstName)).toEqual(["Amy", "Bea"]);
    expect(grouped.get("Youth Beginner")?.map((e) => e.firstName)).toEqual(["Zoe"]);
  });
});

describe("breakHeader", () => {
  it("forces a newline in two-word headers and leaves others alone", () => {
    expect(breakHeader("Tue In")).toBe("Tue\nIn");
    expect(breakHeader("First Name")).toBe("First\nName");
    expect(breakHeader("Age")).toBe("Age");
    expect(breakHeader("Last Tetanus Shot")).toBe("Last Tetanus Shot");
  });
});

describe("sheetFormattingRequests", () => {
  it("offsets the table below the title block and freezes through the header row", () => {
    const requests = sheetFormattingRequests({
      sheetId: 42,
      headers: ["A", "B", "C", "D", "E", "F"],
      dataRows: 7,
      headerRowIndex: TITLE_ROWS,
    });

    const freeze = requests.find((r) => r.updateSheetProperties);
    expect(freeze?.updateSheetProperties?.properties?.gridProperties?.frozenRowCount).toBe(TITLE_ROWS + 1);

    // Banding starts at the header row (below the title block) and covers header + data.
    const banding = requests.find((r) => r.addBanding);
    expect(banding?.addBanding?.bandedRange?.range?.startRowIndex).toBe(TITLE_ROWS);
    expect(banding?.addBanding?.bandedRange?.range?.endRowIndex).toBe(TITLE_ROWS + 1 + 7);

    // Headers are rewritten with forced line breaks at the header row.
    const headerCells = requests.find((r) => r.updateCells);
    expect(headerCells?.updateCells?.start?.rowIndex).toBe(TITLE_ROWS);
  });

  it("applies fixed column widths and a data-row height after auto-sizing", () => {
    const requests = sheetFormattingRequests({
      sheetId: 1,
      headers: ["A", "B", "C", "D", "E"],
      dataRows: 3,
      headerRowIndex: TITLE_ROWS,
      columnWidths: [{ startIndex: 2, endIndex: 3, pixelSize: 55 }],
      dataRowHeight: 42,
    });

    // Auto-resize must come before the explicit width override so the override wins.
    const autoIndex = requests.findIndex((r) => r.autoResizeDimensions);
    const widthIndex = requests.findIndex((r) => r.updateDimensionProperties?.range?.dimension === "COLUMNS");
    expect(autoIndex).toBeGreaterThanOrEqual(0);
    expect(widthIndex).toBeGreaterThan(autoIndex);
    expect(requests[widthIndex]?.updateDimensionProperties?.properties?.pixelSize).toBe(55);

    const rowHeight = requests.find((r) => r.updateDimensionProperties?.range?.dimension === "ROWS");
    expect(rowHeight?.updateDimensionProperties?.range?.startIndex).toBe(TITLE_ROWS + 1);
    expect(rowHeight?.updateDimensionProperties?.properties?.pixelSize).toBe(42);
  });
});

describe("titleBlockRequests", () => {
  it("inserts the title rows and merges the title across all columns", () => {
    const requests = titleBlockRequests(7, "Guppies — July 20", 16);

    const insert = requests.find((r) => r.insertDimension);
    expect(insert?.insertDimension?.range?.endIndex).toBe(TITLE_ROWS);

    const titleMerge = requests.find((r) => r.mergeCells?.range?.startRowIndex === 0);
    expect(titleMerge?.mergeCells?.range?.endColumnIndex).toBe(16);

    // The instructor row must merge the full width (from column 0) so the label doesn't
    // widen the First Name column.
    const instructorMerge = requests.find((r) => r.mergeCells?.range?.startRowIndex === 1);
    expect(instructorMerge?.mergeCells?.range?.startColumnIndex).toBe(0);
    expect(instructorMerge?.mergeCells?.range?.endColumnIndex).toBe(16);
  });
});

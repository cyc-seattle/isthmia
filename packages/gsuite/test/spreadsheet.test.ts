import { describe, it, expect, vi } from "vitest";
import { Table } from "../src/spreadsheet.js";
import type { GoogleSpreadsheetWorksheet } from "google-spreadsheet";

type CellValue = string | number | boolean | null;

function makeMockWorksheet(rowCount: number, columnCount: number) {
  const cells = new Map<string, { value: CellValue }>();

  const getCell = (row: number, col: number) => {
    const key = `${row},${col}`;
    if (!cells.has(key)) cells.set(key, { value: null });
    return cells.get(key)!;
  };

  return {
    rowCount,
    columnCount,
    getCell,
    saveUpdatedCells: vi.fn().mockResolvedValue(undefined),
    addRows: vi.fn().mockResolvedValue(undefined),
    loadCells: vi.fn().mockResolvedValue(undefined),
  } as unknown as GoogleSpreadsheetWorksheet;
}

function makeHeaders(...headers: string[]) {
  const map = new Map<string, number>();
  headers.forEach((h, i) => map.set(h, i));
  return map;
}

// Mirrors google-spreadsheet: once a cell's value is assigned but not saved, the
// `.value` getter throws "Value has been changed" until saveUpdatedCells() runs.
function makeDirtyThrowingWorksheet(rowCount: number, columnCount: number) {
  const cells = new Map<string, { saved: CellValue; draft: CellValue | undefined }>();
  const getRaw = (row: number, col: number) => {
    const key = `${row},${col}`;
    if (!cells.has(key)) cells.set(key, { saved: null, draft: undefined });
    return cells.get(key)!;
  };
  const getCell = (row: number, col: number) => {
    const raw = getRaw(row, col);
    return {
      get value(): CellValue {
        if (raw.draft !== undefined) throw new Error("Value has been changed");
        return raw.saved;
      },
      set value(v: CellValue) {
        raw.draft = v;
      },
    };
  };
  return {
    rowCount,
    columnCount,
    getCell,
    // seed a saved value without marking the cell dirty
    _seed: (row: number, col: number, v: CellValue) => {
      getRaw(row, col).saved = v;
    },
    saveUpdatedCells: vi.fn().mockResolvedValue(undefined),
    addRows: vi.fn().mockResolvedValue(undefined),
    loadCells: vi.fn().mockResolvedValue(undefined),
  } as unknown as GoogleSpreadsheetWorksheet & { _seed: (r: number, c: number, v: CellValue) => void };
}

describe("Table", () => {
  it("getCellValue reads from worksheet", () => {
    const ws = makeMockWorksheet(3, 2);
    ws.getCell(1, 0).value = "Alice";

    const table = new Table(ws, makeHeaders("Name", "Status"));

    expect(table.getCellValue("Name", 1)).toBe("Alice");
  });

  it("getCellValue reflects updates made via updateRow", () => {
    const ws = makeMockWorksheet(3, 2);
    ws.getCell(1, 1).value = "active";

    const table = new Table(ws, makeHeaders("Name", "Status"));
    table.updateRow(1, { Status: "cancelled" });

    // With the old cellCache this returned stale "active"
    expect(table.getCellValue("Status", 1)).toBe("cancelled");
  });

  it("findRows returns all matching row indices", () => {
    const ws = makeMockWorksheet(5, 2);
    ws.getCell(1, 0).value = "Alice";
    ws.getCell(2, 0).value = "Bob";
    ws.getCell(3, 0).value = "Alice";
    ws.getCell(4, 0).value = "Carol";

    const table = new Table(ws, makeHeaders("Name", "Status"));

    expect(table.findRows({ Name: "Alice" })).toEqual([1, 3]);
  });

  it("findRows sees values updated via updateRow", () => {
    const ws = makeMockWorksheet(4, 2);
    ws.getCell(1, 1).value = "active";
    ws.getCell(2, 1).value = "active";
    ws.getCell(3, 1).value = "active";

    const table = new Table(ws, makeHeaders("Name", "Status"));
    table.updateRow(2, { Status: "cancelled" });

    // With the old cellCache, findRows would use stale data and miss the update
    expect(table.findRows({ Status: "cancelled" })).toEqual([2]);
    expect(table.findRows({ Status: "active" })).toEqual([1, 3]);
  });

  it("addOrUpdate adds a new row when no key match exists", () => {
    const ws = makeMockWorksheet(2, 2);
    const table = new Table(ws, makeHeaders("Id", "Name"));

    const result = table.addOrUpdate(["Id"], { Id: "abc", Name: "Alice" });

    expect(result.existing).toBe(false);
  });

  it("addOrUpdate updates the existing row when key matches", () => {
    const ws = makeMockWorksheet(3, 2);
    ws.getCell(1, 0).value = "abc";
    ws.getCell(1, 1).value = "Alice";

    const table = new Table(ws, makeHeaders("Id", "Name"));

    const result = table.addOrUpdate(["Id"], { Id: "abc", Name: "Alice Updated" });

    expect(result.existing).toBe(true);
    expect(table.getCellValue("Name", 1)).toBe("Alice Updated");
  });

  // Regression: findRows must not re-read a cell that updateRow modified, because
  // google-spreadsheet's `.value` getter throws "Value has been changed" for a
  // dirty (assigned-but-unsaved) cell.
  it("findRows does not throw after a prior updateRow dirtied a cell", () => {
    const ws = makeDirtyThrowingWorksheet(4, 2) as GoogleSpreadsheetWorksheet & {
      _seed: (r: number, c: number, v: CellValue) => void;
    };
    ws._seed(1, 0, "abc");
    ws._seed(1, 1, "active");
    ws._seed(2, 0, "def");
    ws._seed(2, 1, "active");

    const table = new Table(ws, makeHeaders("Id", "Status"));

    // Reading the live dirty cell would throw here without the write-through cache.
    table.updateRow(1, { Id: "abc", Status: "cancelled" });

    expect(() => table.findRows({ Status: "active" })).not.toThrow();
    expect(table.findRows({ Status: "active" })).toEqual([2]);
    expect(table.findRows({ Status: "cancelled" })).toEqual([1]);
  });

  it("addOrUpdate over multiple rows does not throw on the throwing worksheet", () => {
    const ws = makeDirtyThrowingWorksheet(4, 2) as GoogleSpreadsheetWorksheet & {
      _seed: (r: number, c: number, v: CellValue) => void;
    };
    ws._seed(1, 0, "abc");
    ws._seed(1, 1, "Alice");

    const table = new Table(ws, makeHeaders("Id", "Name"));

    // First update dirties row 1; the second addOrUpdate's findRows must not throw.
    table.addOrUpdate(["Id"], { Id: "abc", Name: "Alice Updated" });
    expect(() => table.addOrUpdate(["Id"], { Id: "abc", Name: "Alice Again" })).not.toThrow();
    expect(table.getCellValue("Name", 1)).toBe("Alice Again");
  });
});

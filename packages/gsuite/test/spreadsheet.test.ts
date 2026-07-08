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
});

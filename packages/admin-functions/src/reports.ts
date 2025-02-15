import { TypedSpreadsheet } from "./spreadsheets.js";

export abstract class Report {
  constructor(protected readonly spreadsheet: TypedSpreadsheet) {}
  abstract run(argument: string, sheet: string): Promise<void>;
}

export type ReportConstructor = new (spreadsheet: TypedSpreadsheet) => Report;



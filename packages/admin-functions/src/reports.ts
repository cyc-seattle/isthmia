import winston from 'winston';
import { TypedSpreadsheet } from './spreadsheets.js';

export abstract class Report {
  constructor(protected readonly spreadsheet: TypedSpreadsheet) {}
  abstract run(argument: string, sheetName: string): Promise<void>;
}

export type ReportConstructor = new (spreadsheet: TypedSpreadsheet) => Report;

export async function executeQuery<T extends Parse.Object>(
  query: Parse.Query<T>,
) {
  winston.debug('Executing query', query.toJSON());
  return query.find();
}

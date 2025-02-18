import { TypedSpreadsheet } from './spreadsheets.js';
import { Notifier } from './notifications.js';
import { Interval } from 'luxon';

export interface ReportOptions {
  readonly arguments: string;
  readonly spreadsheet: TypedSpreadsheet;
  readonly sheetName: string;
  readonly interval: Interval;
  readonly notifier: Notifier;
}

export abstract class Report {
  readonly arguments: string;
  readonly spreadsheet: TypedSpreadsheet;
  readonly sheetName: string;
  readonly interval: Interval;
  readonly notifier: Notifier;

  constructor(options: ReportOptions) {
    this.arguments = options.arguments;
    this.spreadsheet = options.spreadsheet;
    this.sheetName = options.sheetName;
    this.interval = options.interval;
    this.notifier = options.notifier;
  }

  abstract run(): Promise<void>;

  /**
   * Extends a Parse query to filter the results to be between this report's interval.
   */
  protected updatedBetween<T extends Parse.Object<Parse.BaseAttributes>>(
    query: Parse.Query<T>,
  ) {
    if (this.interval.start) {
      query.greaterThanOrEqualTo('updatedAt', this.interval.start.toJSDate());
    }
    if (this.interval.end) {
      query.lessThan('updatedAt', this.interval.end.toJSDate()!);
    }
    return query;
  }
}

export type ReportConstructor = new (options: ReportOptions) => Report;

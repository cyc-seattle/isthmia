import { HeaderValues, Row, Spreadsheet } from './spreadsheets.js';
import { Notifier } from './notifications.js';
import { DateTime, FixedOffsetZone, Interval } from 'luxon';

export interface ReportOptions {
  readonly arguments: string;
  readonly spreadsheet: Spreadsheet;
  readonly sheetName: string;
  readonly interval: Interval;
  readonly notifier: Notifier;
}

export abstract class Report {
  readonly arguments: string;
  readonly spreadsheet: Spreadsheet;
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

  protected async getOrCreateTable<T extends Row>(
    headerValues: HeaderValues<T>,
  ) {
    const worksheet = await this.spreadsheet.getOrCreateWorksheet(
      this.sheetName,
      headerValues,
    );
    return worksheet.getTable();
  }

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

  /**
   * Reconfigure a JS Date object to a date-string configured for the spreadsheet's timezone and locale.
   */
  protected reconfigureDate(date: Date) {
    // Clubspot dates are UTC, we want to convert these to the spreadsheet
    const utcDate = DateTime.fromJSDate(date, {
      zone: FixedOffsetZone.utcInstance,
    });
    const locale = this.spreadsheet.locale.replace('_', '-');
    return utcDate.setLocale(locale).setZone(this.spreadsheet.timeZone);
  }

  /**
   * Formats a JS Date object with the spreadsheet's locale and timezone.
   * @param date For
   */
  protected formatDate(date?: Date, formatOpts?: Intl.DateTimeFormatOptions) {
    if (date === undefined) {
      return '';
    }

    return this.reconfigureDate(date).toLocaleString(
      formatOpts ?? DateTime.DATE_SHORT,
    );
  }
}

export type ReportConstructor = new (options: ReportOptions) => Report;

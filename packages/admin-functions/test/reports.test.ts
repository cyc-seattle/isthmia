import { describe, it, expect } from "vitest";
import { Interval } from "luxon";
import type { Auth } from "googleapis";
import type { Spreadsheet } from "@cyc-seattle/gsuite";
import { Report, ReportOptions } from "../src/reports.js";
import { NopNotifier } from "../src/notifications.js";

// Pacific/Kiritimati is UTC+14 with no DST, so a UTC instant late in the day
// reliably rolls over to the next local date -- exactly what reconfigureDate exists to handle.
const TIME_ZONE = "Pacific/Kiritimati";

class TestReport extends Report {
  async run() {}

  public callReconfigureDate(date: Date) {
    return this.reconfigureDate(date);
  }

  public callFormatDate(date?: Date, formatOpts?: Intl.DateTimeFormatOptions) {
    return this.formatDate(date, formatOpts);
  }
}

function buildReport(locale: string) {
  const spreadsheet = { locale, timeZone: TIME_ZONE } as unknown as Spreadsheet;

  const options: ReportOptions = {
    arguments: "",
    auth: {} as Auth,
    spreadsheet,
    sheetName: "Test",
    interval: Interval.fromISO("2024-01-01/2024-01-02"),
    notifier: new NopNotifier(),
  };

  return new TestReport(options);
}

describe("Report.reconfigureDate", () => {
  it("re-zones a UTC instant onto the spreadsheet's local date", () => {
    const report = buildReport("en_US");
    // 2024-06-14T23:00Z is still June 14 in UTC, but June 15 at UTC+14.
    const result = report.callReconfigureDate(new Date("2024-06-14T23:00:00.000Z"));

    expect(result.zoneName).toBe(TIME_ZONE);
    expect({ year: result.year, month: result.month, day: result.day }).toEqual({
      year: 2024,
      month: 6,
      day: 15,
    });
  });

  it("converts an underscore-separated spreadsheet locale to a hyphenated tag", () => {
    const report = buildReport("en_US");
    const result = report.callReconfigureDate(new Date("2024-06-14T23:00:00.000Z"));

    expect(result.locale).toBe("en-US");
  });
});

describe("Report.formatDate", () => {
  it("returns an empty string when the date is undefined", () => {
    const report = buildReport("en_US");
    expect(report.callFormatDate(undefined)).toBe("");
  });

  it("defaults to DateTime.DATE_SHORT in the spreadsheet's local date", () => {
    const report = buildReport("en_US");
    const result = report.callFormatDate(new Date("2024-06-14T23:00:00.000Z"));

    expect(result).toContain("2024");
    expect(result).toContain("15");
  });

  it("honors an explicit format argument", () => {
    const report = buildReport("en_US");
    const date = new Date("2024-06-14T23:00:00.000Z");

    expect(report.callFormatDate(date, { day: "2-digit" })).toBe("15");
    expect(report.callFormatDate(date, { month: "long" })).toBe("June");
  });
});

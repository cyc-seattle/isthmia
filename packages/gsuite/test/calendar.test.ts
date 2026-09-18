import { describe, it, expect, vi } from "vitest";
import { Calendar } from "../src/calendar.js";
import type { calendar_v3 } from "googleapis";
import { DateTime } from "luxon";

function makeMockClient(get: ReturnType<typeof vi.fn>) {
  return { events: { get } } as unknown as calendar_v3.Calendar;
}

function makeMockInsertClient(insert: ReturnType<typeof vi.fn>) {
  return { events: { insert } } as unknown as calendar_v3.Calendar;
}

function makeMockUpdateClient(update: ReturnType<typeof vi.fn>) {
  return { events: { update } } as unknown as calendar_v3.Calendar;
}

describe("Calendar.getEvent", () => {
  it("returns a CalendarEvent for a normal event", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-1",
        status: "confirmed",
        summary: "Regatta",
        start: { dateTime: "2026-09-18T10:00:00-07:00" },
        end: { dateTime: "2026-09-18T12:00:00-07:00" },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-1");

    expect(event).not.toBeNull();
    expect(event?.id).toBe("event-1");
    expect(event?.title).toBe("Regatta");
  });

  it("returns null for a cancelled event", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { id: "event-1", status: "cancelled" },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-1");

    expect(event).toBeNull();
  });

  it("returns null when the request throws a 404", async () => {
    const get = vi.fn().mockRejectedValue({ code: 404 });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-1");

    expect(event).toBeNull();
  });

  it("rethrows any other error", async () => {
    const get = vi.fn().mockRejectedValue({ code: 500 });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    await expect(calendar.getEvent("event-1")).rejects.toEqual({ code: 500 });
  });
});

describe("Calendar.getEvent — conversion from a Google event", () => {
  it("treats a start.date event as all-day and reads dates from start/end.date", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-2",
        status: "confirmed",
        summary: "Work Party",
        start: { date: "2026-09-19" },
        end: { date: "2026-09-20" },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-2");

    expect(event?.allDay).toBe(true);
    expect(event?.startTime.toISODate()).toBe("2026-09-19");
    expect(event?.endTime.toISODate()).toBe("2026-09-20");
  });

  it("treats a start.dateTime event as timed and reads instants from start/end.dateTime", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-3",
        status: "confirmed",
        summary: "Committee Meeting",
        start: { dateTime: "2026-09-18T18:00:00-07:00" },
        end: { dateTime: "2026-09-18T19:00:00-07:00" },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-3");

    expect(event?.allDay).toBe(false);
    expect(event?.startTime.toISO()).toBe(DateTime.fromISO("2026-09-18T18:00:00-07:00").toISO());
    expect(event?.endTime.toISO()).toBe(DateTime.fromISO("2026-09-18T19:00:00-07:00").toISO());
  });

  it("falls back to 'Untitled Event' when summary is missing", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-4",
        status: "confirmed",
        start: { dateTime: "2026-09-18T18:00:00-07:00" },
        end: { dateTime: "2026-09-18T19:00:00-07:00" },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-4");

    expect(event?.title).toBe("Untitled Event");
  });

  it("sets description, location, and metadata only when the Google event has them", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-5",
        status: "confirmed",
        summary: "Regatta",
        start: { dateTime: "2026-09-18T10:00:00-07:00" },
        end: { dateTime: "2026-09-18T12:00:00-07:00" },
        description: "Fall series race",
        location: "CYC",
        extendedProperties: { private: { source: "clubspot" } },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-5");

    expect(event).toMatchObject({
      description: "Fall series race",
      location: "CYC",
      metadata: { source: "clubspot" },
    });
  });

  it("omits description, location, and metadata when the Google event lacks them", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "event-6",
        status: "confirmed",
        summary: "Regatta",
        start: { dateTime: "2026-09-18T10:00:00-07:00" },
        end: { dateTime: "2026-09-18T12:00:00-07:00" },
      },
    });
    const calendar = new Calendar(makeMockClient(get), "cal-1");

    const event = await calendar.getEvent("event-6");

    expect(event).not.toHaveProperty("description");
    expect(event).not.toHaveProperty("location");
    expect(event).not.toHaveProperty("metadata");
  });
});

describe("Calendar.createEvent / updateEvent — conversion to a Google event", () => {
  it("createEvent sends an all-day request body with date, not dateTime", async () => {
    const insert = vi.fn().mockResolvedValue({
      data: { id: "event-10", start: { date: "2026-09-19" }, end: { date: "2026-09-20" } },
    });
    const calendar = new Calendar(makeMockInsertClient(insert), "cal-1");

    await calendar.createEvent("cal-1", {
      title: "Work Party",
      startTime: DateTime.fromISO("2026-09-19"),
      endTime: DateTime.fromISO("2026-09-20"),
      allDay: true,
    });

    const requestBody = insert.mock.calls[0][0].requestBody;
    expect(requestBody.start).toEqual({ date: "2026-09-19" });
    expect(requestBody.end).toEqual({ date: "2026-09-20" });
  });

  it("createEvent sends a timed request body with dateTime, not date", async () => {
    const insert = vi.fn().mockResolvedValue({
      data: {
        id: "event-11",
        start: { dateTime: "2026-09-18T18:00:00-07:00" },
        end: { dateTime: "2026-09-18T19:00:00-07:00" },
      },
    });
    const calendar = new Calendar(makeMockInsertClient(insert), "cal-1");

    const startTime = DateTime.fromISO("2026-09-18T18:00:00-07:00");
    const endTime = DateTime.fromISO("2026-09-18T19:00:00-07:00");

    await calendar.createEvent("cal-1", {
      title: "Committee Meeting",
      startTime,
      endTime,
      allDay: false,
    });

    const requestBody = insert.mock.calls[0][0].requestBody;
    expect(requestBody.start).toEqual({ dateTime: startTime.toISO() });
    expect(requestBody.end).toEqual({ dateTime: endTime.toISO() });
  });

  it("updateEvent sends extendedProperties.private built from metadata", async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: "event-12" } });
    const calendar = new Calendar(makeMockUpdateClient(update), "cal-1");

    await calendar.updateEvent("cal-1", {
      id: "event-12",
      title: "Regatta",
      startTime: DateTime.fromISO("2026-09-18T10:00:00-07:00"),
      endTime: DateTime.fromISO("2026-09-18T12:00:00-07:00"),
      allDay: false,
      metadata: { source: "clubspot" },
    });

    const requestBody = update.mock.calls[0][0].requestBody;
    expect(requestBody.extendedProperties).toEqual({ private: { source: "clubspot" } });
  });

  it("updateEvent omits extendedProperties when there is no metadata", async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: "event-13" } });
    const calendar = new Calendar(makeMockUpdateClient(update), "cal-1");

    await calendar.updateEvent("cal-1", {
      id: "event-13",
      title: "Regatta",
      startTime: DateTime.fromISO("2026-09-18T10:00:00-07:00"),
      endTime: DateTime.fromISO("2026-09-18T12:00:00-07:00"),
      allDay: false,
    });

    const requestBody = update.mock.calls[0][0].requestBody;
    expect(requestBody).not.toHaveProperty("extendedProperties");
  });
});

import { describe, it, expect, vi } from "vitest";
import { Calendar } from "../src/calendar.js";
import type { calendar_v3 } from "googleapis";

function makeMockClient(get: ReturnType<typeof vi.fn>) {
  return { events: { get } } as unknown as calendar_v3.Calendar;
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

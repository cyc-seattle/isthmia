import { describe, it, expect, vi } from "vitest";
import winston from "winston";
import type { Camp, CampClass, CampSession, EntryCap } from "@cyc-seattle/clubspot-sdk";
import { SessionClassRow } from "@cyc-seattle/clubspot";
import {
  planCamps,
  planClasses,
  planEntryCaps,
  planSessionClasses,
  planSessions,
  SCHEDULE_CREATE_ORDER,
} from "../src/schedule.js";
import { CampWithClubspot, ClassWithClubspot, EntryCapWithClubspot, SessionWithClubspot } from "../src/schema.js";

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor, per roster.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function chartOfAccounts(id: string, code: string | undefined) {
  return parseObject(id, { code });
}

function camp(id: string, name: string, opts: { chartOfAccounts?: ReturnType<typeof chartOfAccounts> } = {}) {
  return parseObject(id, { name, chartOfAccounts: opts.chartOfAccounts });
}

function campClass(id: string, campId: string, name: string) {
  return parseObject(id, { campObject: { id: campId }, name });
}

function campSession(
  id: string,
  campId: string,
  name: string,
  opts: {
    classes?: ReturnType<typeof campClass>[];
    startDate?: Date | undefined;
    endDate?: Date | undefined;
    archived?: boolean;
  } = {},
) {
  return parseObject(id, {
    campObject: { id: campId },
    name,
    startDate: "startDate" in opts ? opts.startDate : new Date("2026-06-01T00:00:00Z"),
    endDate: "endDate" in opts ? opts.endDate : new Date("2026-06-05T00:00:00Z"),
    campClassesArray: opts.classes,
    archived: opts.archived,
  });
}

function entryCap(id: string, classId: string, cap: number, sessionId?: string) {
  return parseObject(id, {
    campClassObject: { id: classId },
    campSessionObject: sessionId ? { id: sessionId } : undefined,
    cap,
  });
}

describe("planCamps", () => {
  it("creates a camp for a Clubspot camp not yet in the CRM", () => {
    const plan = planCamps([camp("camp-1", "Youth Camp") as unknown as Camp], []);
    expect(plan.toCreate).toEqual([
      {
        name: "Youth Camp",
        clubspot_camp_id: "camp-1",
        start_date: null,
        end_date: null,
        clubspot_sales_account: null,
        synced_through: null,
        quiet_runs: 0,
      },
    ]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("does neither for a camp already present with the same values", () => {
    const existing: CampWithClubspot[] = [
      {
        id: "row-1",
        name: "Youth Camp",
        clubspot_camp_id: "camp-1",
        start_date: null,
        end_date: null,
        clubspot_sales_account: null,
        synced_through: null,
        quiet_runs: 0,
      },
    ];
    const plan = planCamps([camp("camp-1", "Youth Camp") as unknown as Camp], existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("updates the existing row's id when a field changed", () => {
    const existing: CampWithClubspot[] = [
      {
        id: "row-1",
        name: "Old Name",
        clubspot_camp_id: "camp-1",
        start_date: null,
        end_date: null,
        clubspot_sales_account: null,
        synced_through: null,
        quiet_runs: 0,
      },
    ];
    const plan = planCamps([camp("camp-1", "New Name") as unknown as Camp], existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { name: "New Name" } }]);
  });

  // A camp that has been synced and backed off must not have its watermark or backoff state
  // clobbered by an unrelated schedule change.
  it("never writes synced_through or quiet_runs, even when an existing camp's other fields change", () => {
    const existing: CampWithClubspot[] = [
      {
        id: "row-1",
        name: "Old Name",
        clubspot_camp_id: "camp-1",
        start_date: null,
        end_date: null,
        clubspot_sales_account: null,
        synced_through: "2026-01-01T00:00:00.000Z",
        quiet_runs: 3,
      },
    ];
    const plan = planCamps([camp("camp-1", "New Name") as unknown as Camp], existing);
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { name: "New Name" } }]);
    expect(plan.toUpdate[0]?.patch).not.toHaveProperty("synced_through");
    expect(plan.toUpdate[0]?.patch).not.toHaveProperty("quiet_runs");
  });

  it("populates clubspot_sales_account from the camp's chart-of-accounts code", () => {
    const withAccount = camp("camp-1", "Youth Camp", { chartOfAccounts: chartOfAccounts("coa-1", "4000-YOUTH") });
    const plan = planCamps([withAccount as unknown as Camp], []);
    expect(plan.toCreate[0]).toMatchObject({ clubspot_sales_account: "4000-YOUTH" });
  });

  it("writes null when the camp has no chart-of-accounts set up", () => {
    const plan = planCamps([camp("camp-1", "Youth Camp") as unknown as Camp], []);
    expect(plan.toCreate[0]).toMatchObject({ clubspot_sales_account: null });
  });

  it("throws rather than writing null when the chartOfAccounts pointer is present but unfetched", () => {
    // A present pointer with no code means the query forgot .include("chartOfAccounts") - silently
    // writing null here would be indistinguishable from a camp that genuinely has no account.
    const unfetched = camp("camp-1", "Youth Camp", { chartOfAccounts: chartOfAccounts("coa-1", undefined) });
    expect(() => planCamps([unfetched as unknown as Camp], [])).toThrow(/chartOfAccounts/);
  });
});

describe("planClasses", () => {
  it("resolves camp_id through the lookup and creates a new class unlinked from any program", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const plan = planClasses(
      [campClass("class-1", "camp-1", "Optimist") as unknown as CampClass],
      campCrmIdByClubspotCampId,
      [],
    );
    expect(plan.toCreate).toEqual([
      { camp_id: "camp-row-1", name: "Optimist", clubspot_class_id: "class-1", program_id: null },
    ]);
  });

  it("throws when the camp hasn't been synced yet", () => {
    expect(() =>
      planClasses([campClass("class-1", "camp-1", "Optimist") as unknown as CampClass], new Map(), []),
    ).toThrow(/camp/);
  });

  it("produces no update for an unchanged class", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const existing: ClassWithClubspot[] = [
      { id: "row-1", camp_id: "camp-row-1", name: "Optimist", clubspot_class_id: "class-1", program_id: null },
    ];
    const plan = planClasses(
      [campClass("class-1", "camp-1", "Optimist") as unknown as CampClass],
      campCrmIdByClubspotCampId,
      existing,
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  // The regression test for step 5: staff link a class to its program by hand, and a nightly
  // re-sync must never undo it.
  it("never writes program_id, even when an existing class's other fields change", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const existing: ClassWithClubspot[] = [
      {
        id: "row-1",
        camp_id: "camp-row-1",
        name: "Old Name",
        clubspot_class_id: "class-1",
        program_id: "program-row-1",
      },
    ];
    const plan = planClasses(
      [campClass("class-1", "camp-1", "New Name") as unknown as CampClass],
      campCrmIdByClubspotCampId,
      existing,
    );
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { name: "New Name" } }]);
    expect(plan.toUpdate[0]?.patch).not.toHaveProperty("program_id");
  });
});

describe("planSessions", () => {
  it("resolves camp_id and formats the dates", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const plan = planSessions(
      [campSession("session-1", "camp-1", "Week 1") as unknown as CampSession],
      campCrmIdByClubspotCampId,
      [],
    );
    expect(plan.toCreate).toEqual([
      {
        camp_id: "camp-row-1",
        name: "Week 1",
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-1",
        archived: false,
      },
    ]);
  });

  it("updates the existing row when the name changed", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const existing: SessionWithClubspot[] = [
      {
        id: "row-1",
        camp_id: "camp-row-1",
        name: "Old Name",
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-1",
        archived: false,
      },
    ];
    const plan = planSessions(
      [campSession("session-1", "camp-1", "Week 1") as unknown as CampSession],
      campCrmIdByClubspotCampId,
      existing,
    );
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { name: "Week 1" } }]);
  });

  it("writes null dates and warns for a session missing one or both dates, without disturbing the rest of the plan", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const plan = planSessions(
      [
        campSession("session-1", "camp-1", "Week 1") as unknown as CampSession,
        campSession("session-2", "camp-1", "Week 2", { startDate: undefined }) as unknown as CampSession,
        campSession("session-3", "camp-1", "Week 3", { endDate: undefined }) as unknown as CampSession,
        campSession("session-4", "camp-1", "Week 4", {
          startDate: undefined,
          endDate: undefined,
        }) as unknown as CampSession,
      ],
      campCrmIdByClubspotCampId,
      [],
    );
    expect(plan.toCreate).toEqual([
      {
        camp_id: "camp-row-1",
        name: "Week 1",
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-1",
        archived: false,
      },
      {
        camp_id: "camp-row-1",
        name: "Week 2",
        start_date: null,
        end_date: "2026-06-05",
        clubspot_session_id: "session-2",
        archived: false,
      },
      {
        camp_id: "camp-row-1",
        name: "Week 3",
        start_date: "2026-06-01",
        end_date: null,
        clubspot_session_id: "session-3",
        archived: false,
      },
      {
        camp_id: "camp-row-1",
        name: "Week 4",
        start_date: null,
        end_date: null,
        clubspot_session_id: "session-4",
        archived: false,
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session-2"), expect.anything());
    warn.mockRestore();
  });

  it("writes a null name for a legacy session with none, mapping the rest of the row normally", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const nameless = campSession("session-1", "camp-1", undefined as unknown as string);
    const plan = planSessions([nameless as unknown as CampSession], campCrmIdByClubspotCampId, []);
    expect(plan.toCreate).toEqual([
      {
        camp_id: "camp-row-1",
        name: null,
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-1",
        archived: false,
      },
    ]);
  });

  it("maps archived true and defaults a missing value to false", () => {
    const campCrmIdByClubspotCampId = new Map([["camp-1", "camp-row-1"]]);
    const plan = planSessions(
      [
        campSession("session-1", "camp-1", "Week 1", { archived: true }) as unknown as CampSession,
        campSession("session-2", "camp-1", "Week 2") as unknown as CampSession,
      ],
      campCrmIdByClubspotCampId,
      [],
    );
    expect(plan.toCreate).toEqual([
      {
        camp_id: "camp-row-1",
        name: "Week 1",
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-1",
        archived: true,
      },
      {
        camp_id: "camp-row-1",
        name: "Week 2",
        start_date: "2026-06-01",
        end_date: "2026-06-05",
        clubspot_session_id: "session-2",
        archived: false,
      },
    ]);
  });
});

describe("planEntryCaps", () => {
  const classById = new Map([["class-1", "class-row-1"]]);
  const sessionById = new Map([["session-1", "session-row-1"]]);

  it("applies across every session when the cap has no session", () => {
    const plan = planEntryCaps([entryCap("cap-1", "class-1", 10) as unknown as EntryCap], classById, sessionById, []);
    expect(plan.toCreate).toEqual([
      { class_id: "class-row-1", session_id: null, cap: 10, clubspot_entry_cap_id: "cap-1" },
    ]);
  });

  it("scopes to one session when the cap has one", () => {
    const plan = planEntryCaps(
      [entryCap("cap-1", "class-1", 10, "session-1") as unknown as EntryCap],
      classById,
      sessionById,
      [],
    );
    expect(plan.toCreate).toEqual([
      { class_id: "class-row-1", session_id: "session-row-1", cap: 10, clubspot_entry_cap_id: "cap-1" },
    ]);
  });

  it("updates the cap amount on an existing row", () => {
    const existing: EntryCapWithClubspot[] = [
      { id: "row-1", class_id: "class-row-1", session_id: null, cap: 10, clubspot_entry_cap_id: "cap-1" },
    ];
    const plan = planEntryCaps(
      [entryCap("cap-1", "class-1", 15) as unknown as EntryCap],
      classById,
      sessionById,
      existing,
    );
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { cap: 15 } }]);
  });

  it("drops a cap referencing an unresolvable session, warns, and still plans the rest", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    const plan = planEntryCaps(
      [
        entryCap("cap-1", "class-1", 10, "session-missing") as unknown as EntryCap,
        entryCap("cap-2", "class-1", 5, "session-1") as unknown as EntryCap,
      ],
      classById,
      sessionById,
      [],
    );
    expect(plan.toCreate).toEqual([
      { class_id: "class-row-1", session_id: "session-row-1", cap: 5, clubspot_entry_cap_id: "cap-2" },
    ]);
    expect(plan.skipped).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cap-1"), expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session-missing"), expect.anything());
    warn.mockRestore();
  });

  it("still throws when the class hasn't been synced yet", () => {
    expect(() =>
      planEntryCaps([entryCap("cap-1", "class-missing", 10) as unknown as EntryCap], classById, sessionById, []),
    ).toThrow(/class/);
  });
});

describe("planSessionClasses", () => {
  const sessionByClubspotId = new Map([["session-1", "session-row-1"]]);
  const classByClubspotId = new Map([
    ["class-1", "class-row-1"],
    ["class-2", "class-row-2"],
    ["class-3", "class-row-3"],
  ]);
  const campClassCrmIds = ["class-row-1", "class-row-2", "class-row-3"];

  it("expands allClasses into one row per class in the camp", () => {
    const session = campSession("session-1", "camp-1", "Week 1") as unknown as CampSession;
    const plan = planSessionClasses([session], sessionByClubspotId, classByClubspotId, campClassCrmIds, []);
    expect(plan.toCreate).toHaveLength(3);
    expect(new Set(plan.toCreate.map((row) => row.class_id))).toEqual(new Set(campClassCrmIds));
    expect(plan.toRemove).toEqual([]);
  });

  it("uses exactly the explicit campClassesArray and nothing else", () => {
    const session = campSession("session-1", "camp-1", "Week 1", {
      classes: [campClass("class-1", "camp-1", "Optimist"), campClass("class-2", "camp-1", "Laser")],
    }) as unknown as CampSession;
    const plan = planSessionClasses([session], sessionByClubspotId, classByClubspotId, campClassCrmIds, []);
    expect(new Set(plan.toCreate.map((row) => row.class_id))).toEqual(new Set(["class-row-1", "class-row-2"]));
  });

  it("removes a row whose class is no longer offered by that session", () => {
    const session = campSession("session-1", "camp-1", "Week 1", {
      classes: [campClass("class-1", "camp-1", "Optimist")],
    }) as unknown as CampSession;
    const existing: SessionClassRow[] = [
      { id: "row-1", session_id: "session-row-1", class_id: "class-row-1" },
      { id: "row-2", session_id: "session-row-1", class_id: "class-row-2" },
    ];
    const plan = planSessionClasses([session], sessionByClubspotId, classByClubspotId, campClassCrmIds, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRemove).toEqual([{ id: "row-2", session_id: "session-row-1", class_id: "class-row-2" }]);
  });
});

describe("SCHEDULE_CREATE_ORDER", () => {
  it("puts camps before its dependents, and sessions/classes before their dependents", () => {
    const index = (name: (typeof SCHEDULE_CREATE_ORDER)[number]) => SCHEDULE_CREATE_ORDER.indexOf(name);
    expect(index("camps")).toBeLessThan(index("sessions"));
    expect(index("camps")).toBeLessThan(index("classes"));
    expect(index("sessions")).toBeLessThan(index("session_classes"));
    expect(index("classes")).toBeLessThan(index("session_classes"));
    expect(index("sessions")).toBeLessThan(index("entry_caps"));
    expect(index("classes")).toBeLessThan(index("entry_caps"));
  });
});

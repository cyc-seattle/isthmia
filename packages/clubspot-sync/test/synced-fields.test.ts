import { describe, it, expect } from "vitest";
import {
  bestRanked,
  isNewestParticipant,
  parseYesNo,
  planSyncedField,
  planSyncedFields,
  Ranked,
  RegistrationRank,
  resolveBase,
  resolveFieldBase,
} from "../src/synced-fields.js";

describe("parseYesNo", () => {
  it("parses Yes and No case-insensitively", () => {
    expect(parseYesNo("Yes")).toBe(true);
    expect(parseYesNo("yes")).toBe(true);
    expect(parseYesNo("YES")).toBe(true);
    expect(parseYesNo("No")).toBe(false);
    expect(parseYesNo("no")).toBe(false);
    expect(parseYesNo("NO")).toBe(false);
  });

  it("treats blank, including whitespace-only, as not answered", () => {
    expect(parseYesNo(null)).toBeNull();
    expect(parseYesNo("")).toBeNull();
    expect(parseYesNo("   ")).toBeNull();
  });

  it("is undefined for anything else, rather than defaulting to false", () => {
    expect(parseYesNo("Maybe")).toBeUndefined();
    expect(parseYesNo("y")).toBeUndefined();
  });
});

describe("planSyncedField", () => {
  it("writes v when there's no prior mirror and the CRM column is null", () => {
    expect(planSyncedField(null, undefined, "Alex")).toEqual({
      action: "write",
      value: "Alex",
      replacedStaffEdit: false,
    });
  });

  it("leaves a first mirror write alone when the CRM column already has a value - fill nulls only", () => {
    expect(planSyncedField("Staff Name", undefined, "Alex")).toEqual({ action: "skip", reason: "already-set" });
  });

  it("never writes a blank v, even on a first mirror write", () => {
    expect(planSyncedField(null, undefined, null)).toEqual({ action: "skip", reason: "blank" });
  });

  it("writes nothing when v repeats base - a staff edit holds", () => {
    expect(planSyncedField("Staff Name", "Alex", "Alex")).toEqual({ action: "skip", reason: "unchanged" });
  });

  it("writes v when it differs from base and current already equals base", () => {
    expect(planSyncedField("Alex", "Alex", "Alexandra")).toEqual({
      action: "write",
      value: "Alexandra",
      replacedStaffEdit: false,
    });
  });

  it("writes v when it differs from base and current is null", () => {
    expect(planSyncedField(null, "Alex", "Alexandra")).toEqual({
      action: "write",
      value: "Alexandra",
      replacedStaffEdit: false,
    });
  });

  it("writes v and counts a replaced staff edit when current is neither base nor null", () => {
    expect(planSyncedField("Staff Name", "Alex", "Alexandra")).toEqual({
      action: "write",
      value: "Alexandra",
      replacedStaffEdit: true,
    });
  });

  it("never writes a blank v, even when it would otherwise differ from base", () => {
    expect(planSyncedField("Staff Name", "Alex", null)).toEqual({ action: "skip", reason: "blank" });
  });

  it("writes v when a later non-null value differs from the last non-null base", () => {
    // base was blank last time (mirror row existed, field was null); Clubspot now answers.
    expect(planSyncedField(null, null, "Alex")).toEqual({
      action: "write",
      value: "Alex",
      replacedStaffEdit: false,
    });
  });
});

interface Row {
  id?: string;
  first_name: string | null;
  last_name: string | null;
}

describe("planSyncedFields", () => {
  const fields = ["first_name", "last_name"] as const;

  it("plans an empty patch when nothing changed", () => {
    const plan = planSyncedFields<Row>(
      fields,
      { first_name: "Alex", last_name: "Rivera" },
      { first_name: "Alex", last_name: "Rivera" },
      { first_name: "Alex", last_name: "Rivera" },
    );
    expect(plan).toEqual({ patch: {}, written: 0, replacedStaffEdits: 0, blankSkipped: 0, replacedFields: [] });
  });

  it("collects every written field into one patch, and names each replaced staff edit", () => {
    const plan = planSyncedFields<Row>(
      fields,
      { first_name: "Staff First", last_name: "Staff Last" },
      { first_name: "Alex", last_name: "Rivera" },
      { first_name: "Alexandra", last_name: null },
    );
    // last_name's v is blank, so only first_name writes - and only it counts as replaced.
    expect(plan).toEqual({
      patch: { first_name: "Alexandra" },
      written: 1,
      replacedStaffEdits: 1,
      blankSkipped: 1,
      replacedFields: ["first_name"],
    });
  });

  it("fills only null columns on a first mirror write, ignoring an already-set field", () => {
    const plan = planSyncedFields<Row>(fields, { first_name: "Staff First", last_name: null }, undefined, {
      first_name: "Alexandra",
      last_name: "Rivera",
    });
    expect(plan).toEqual({
      patch: { last_name: "Rivera" },
      written: 1,
      replacedStaffEdits: 0,
      blankSkipped: 0,
      replacedFields: [],
    });
  });
});

function rank(id: string, archived: boolean, registeredAt: string): RegistrationRank {
  return { id, archived, registered_at: registeredAt };
}

describe("isNewestParticipant", () => {
  it("is true with no other registrations linked to the person", () => {
    expect(isNewestParticipant(rank("reg-1", false, "2026-01-01T00:00:00Z"), [])).toBe(true);
  });

  it("is true when self is registered more recently than every other", () => {
    const self = rank("reg-2", false, "2026-02-01T00:00:00Z");
    const older = rank("reg-1", false, "2026-01-01T00:00:00Z");
    expect(isNewestParticipant(self, [older])).toBe(true);
  });

  it("is false when a non-archived sibling is more recent", () => {
    const self = rank("reg-1", false, "2026-01-01T00:00:00Z");
    const newer = rank("reg-2", false, "2026-02-01T00:00:00Z");
    expect(isNewestParticipant(self, [newer])).toBe(false);
  });

  it("ranks any non-archived registration above an archived one, regardless of date", () => {
    const self = rank("reg-1", false, "2020-01-01T00:00:00Z");
    const archivedNewer = rank("reg-2", true, "2026-01-01T00:00:00Z");
    expect(isNewestParticipant(self, [archivedNewer])).toBe(true);
  });

  it("breaks a tied registered_at on id, descending", () => {
    const self = rank("reg-2", false, "2026-01-01T00:00:00Z");
    const tiedLowerId = rank("reg-1", false, "2026-01-01T00:00:00Z");
    expect(isNewestParticipant(self, [tiedLowerId])).toBe(true);
    expect(isNewestParticipant(tiedLowerId, [self])).toBe(false);
  });
});

describe("bestRanked", () => {
  it("is undefined with no candidates", () => {
    expect(bestRanked([])).toBeUndefined();
  });

  it("picks the newest-ranked candidate, carrying its payload", () => {
    const candidates: Ranked<string>[] = [
      { ...rank("reg-1", false, "2025-01-01T00:00:00Z"), data: "older" },
      { ...rank("reg-2", false, "2026-01-01T00:00:00Z"), data: "newer" },
    ];
    expect(bestRanked(candidates)).toMatchObject({ id: "reg-2", data: "newer" });
  });
});

describe("resolveBase - the previous newest linked participant's fallback (#137)", () => {
  it("prefers its own known value over the fallback", () => {
    expect(resolveBase("own", "fallback")).toBe("own");
  });

  it("falls back when there's no mirror yet at all", () => {
    expect(resolveBase(undefined, "fallback")).toBe("fallback");
  });

  // The mirror keeps Clubspot's last non-blank answer (see people.ts's
  // mergeParticipantMirrorFields), so a stored blank is real information - it means this
  // participant has never answered - not a lost value, and it's used directly rather than falling
  // back to a sibling's own answer.
  it("uses its own known blank rather than falling back, once the mirror row itself exists", () => {
    expect(resolveBase(null, "fallback")).toBeNull();
  });

  it("is undefined - fill-null-only - with no mirror row at all, and no fallback either", () => {
    expect(resolveBase(undefined, undefined)).toBeUndefined();
  });

  // The documented A -> staff S -> blank -> A case: a blank run never clears the participant's own
  // stored "A" (people.ts's mergeParticipantMirrorFields), so its base stays "A" through the blank
  // run, and a later "A" repeats it rather than replacing S - with or without a sibling to fall
  // back to, since `own` is never undefined once the mirror holds a value.
  it("keeps a staff edit when Clubspot's own stored answer is unchanged across a blank run", () => {
    expect(planSyncedField("staff-edited", resolveBase<string>("A", undefined), "A")).toEqual({
      action: "skip",
      reason: "unchanged",
    });
    expect(planSyncedField("staff-edited", resolveBase<string>("A", "sibling-answer"), "A")).toEqual({
      action: "skip",
      reason: "unchanged",
    });
  });

  // The other half of the same fix: once a blank run can no longer erase "peanuts", a later
  // "shellfish" answer still writes, unlike the bug where a lost base made it look already-set.
  it("still writes a changed answer, since a blank run never erases the base it differs from", () => {
    expect(planSyncedField("peanuts", resolveBase<string>("peanuts", undefined), "shellfish")).toEqual({
      action: "write",
      value: "shellfish",
      replacedStaffEdit: false,
    });
  });
});

describe("resolveFieldBase", () => {
  interface Row {
    first_name: string | null;
    phone: string | null;
  }

  it("takes each field's own value when the row is present, even a known blank one - never the fallback's", () => {
    expect(
      resolveFieldBase<Row>({ first_name: "Alex", phone: null }, { first_name: "Someone Else", phone: "old-phone" }),
    ).toEqual({ first_name: "Alex", phone: null });
  });

  it("falls back field by field when there's no own mirror at all", () => {
    expect(resolveFieldBase<Row>(undefined, { first_name: "Alex", phone: "2065550100" })).toEqual({
      first_name: "Alex",
      phone: "2065550100",
    });
  });

  it("leaves a field out entirely when neither side has a value for it", () => {
    expect(resolveFieldBase<Row>(undefined, undefined)).toEqual({});
  });
});

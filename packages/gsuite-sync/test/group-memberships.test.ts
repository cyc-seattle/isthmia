import { describe, expect, it } from "vitest";
import { planMembershipWrites, removedPersonIds } from "../src/group-memberships.js";
import { GoogleGroupMembershipRow } from "../src/schema.js";

const now = new Date("2026-10-24T12:00:00Z");
const timestamp = now.toISOString();
const earlier = "2026-09-01T00:00:00.000Z";

function row(
  id: string,
  personId: string,
  email: string,
  removedAt: string | null = null,
  groupId = "group-1",
): GoogleGroupMembershipRow {
  return { id, group_id: groupId, person_id: personId, email, added_at: earlier, removed_at: removedAt };
}

const alice = { id: "alice", email: "alice@example.com" };

describe("planMembershipWrites", () => {
  it("live, no row: writes a row without adding", () => {
    const plan = planMembershipWrites("group-1", [alice], new Set(["alice@example.com"]), [], now);
    expect(plan).toEqual({
      add: [],
      create: [
        { group_id: "group-1", person_id: "alice", email: "alice@example.com", added_at: timestamp, removed_at: null },
      ],
      update: [],
    });
  });

  it("live, removed_at null: does nothing", () => {
    const plan = planMembershipWrites(
      "group-1",
      [alice],
      new Set(["alice@example.com"]),
      [row("m1", "alice", "alice@example.com")],
      now,
    );
    expect(plan).toEqual({ add: [], create: [], update: [] });
  });

  it("live, removed_at set: clears removed_at", () => {
    const plan = planMembershipWrites(
      "group-1",
      [alice],
      new Set(["alice@example.com"]),
      [row("m1", "alice", "alice@example.com", earlier)],
      now,
    );
    expect(plan).toEqual({ add: [], create: [], update: [{ id: "m1", patch: { removed_at: null } }] });
  });

  it("not live, no row: adds them and writes a row", () => {
    const plan = planMembershipWrites("group-1", [alice], new Set(), [], now);
    expect(plan.add).toEqual(["alice@example.com"]);
    expect(plan.create).toEqual([
      { group_id: "group-1", person_id: "alice", email: "alice@example.com", added_at: timestamp, removed_at: null },
    ]);
    expect(plan.update).toEqual([]);
  });

  it("not live, removed_at null: sets removed_at and doesn't add", () => {
    const plan = planMembershipWrites("group-1", [alice], new Set(), [row("m1", "alice", "alice@example.com")], now);
    expect(plan).toEqual({ add: [], create: [], update: [{ id: "m1", patch: { removed_at: timestamp } }] });
  });

  it("not live, removed_at set: skips them", () => {
    const plan = planMembershipWrites(
      "group-1",
      [alice],
      new Set(),
      [row("m1", "alice", "alice@example.com", earlier)],
      now,
    );
    expect(plan).toEqual({ add: [], create: [], update: [] });
  });

  it("matches live members and rows by normalized email", () => {
    const plan = planMembershipWrites(
      "group-1",
      [{ id: "alice", email: " Alice@Example.com " }],
      new Set(["ALICE@example.com"]),
      [row("m1", "alice", "alice@example.com")],
      now,
    );
    expect(plan).toEqual({ add: [], create: [], update: [] });
  });

  it("ignores another group's rows", () => {
    const plan = planMembershipWrites(
      "group-1",
      [alice],
      new Set(),
      [row("m1", "alice", "alice@example.com", earlier, "group-2")],
      now,
    );
    expect(plan.add).toEqual(["alice@example.com"]);
    expect(plan.create).toHaveLength(1);
  });

  it("skips a person with no usable email", () => {
    const plan = planMembershipWrites("group-1", [{ id: "bad", email: "206-555-0100" }], new Set(), [], now);
    expect(plan).toEqual({ add: [], create: [], update: [] });
  });

  describe("a person whose email changed", () => {
    it("adds the new address and updates the row, since the sync never added it", () => {
      const plan = planMembershipWrites(
        "group-1",
        [{ id: "alice", email: "alice@new.example.com" }],
        new Set(["alice@example.com"]),
        [row("m1", "alice", "alice@example.com")],
        now,
      );
      expect(plan).toEqual({
        add: ["alice@new.example.com"],
        create: [],
        update: [{ id: "m1", patch: { email: "alice@new.example.com", added_at: timestamp } }],
      });
    });

    it("stays removed, and the row's email is updated", () => {
      const plan = planMembershipWrites(
        "group-1",
        [{ id: "alice", email: "alice@new.example.com" }],
        new Set(),
        [row("m1", "alice", "alice@example.com", earlier)],
        now,
      );
      expect(plan).toEqual({ add: [], create: [], update: [{ id: "m1", patch: { email: "alice@new.example.com" } }] });
    });

    it("updates the row's email when the new address is already live", () => {
      const plan = planMembershipWrites(
        "group-1",
        [{ id: "alice", email: "alice@new.example.com" }],
        new Set(["alice@new.example.com"]),
        [row("m1", "alice", "alice@example.com")],
        now,
      );
      expect(plan).toEqual({ add: [], create: [], update: [{ id: "m1", patch: { email: "alice@new.example.com" } }] });
    });
  });

  describe("people who share an address", () => {
    const parent = { id: "parent", email: "family@example.com" };
    const child = { id: "child", email: "family@example.com" };

    it("adds the address once and writes a row for each person", () => {
      const plan = planMembershipWrites("group-1", [parent, child], new Set(), [], now);
      expect(plan.add).toEqual(["family@example.com"]);
      expect(plan.create.map((created) => created.person_id)).toEqual(["parent", "child"]);
    });

    it("doesn't re-add the address when one of them is recorded as removed", () => {
      const plan = planMembershipWrites(
        "group-1",
        [parent, child],
        new Set(),
        [row("m1", "parent", "family@example.com", earlier)],
        now,
      );
      expect(plan).toEqual({ add: [], create: [], update: [] });
    });

    it("marks every active row removed when the address leaves", () => {
      const plan = planMembershipWrites(
        "group-1",
        [parent, child],
        new Set(),
        [row("m1", "parent", "family@example.com"), row("m2", "child", "family@example.com")],
        now,
      );
      expect(plan.add).toEqual([]);
      expect(plan.update).toEqual([
        { id: "m1", patch: { removed_at: timestamp } },
        { id: "m2", patch: { removed_at: timestamp } },
      ]);
    });
  });

  it("prefers a removed row when a merge left a person two", () => {
    const plan = planMembershipWrites(
      "group-1",
      [alice],
      new Set(),
      [row("m1", "alice", "alice@example.com"), row("m2", "alice", "alice@example.com", earlier)],
      now,
    );
    expect(plan).toEqual({ add: [], create: [], update: [] });
  });
});

describe("removedPersonIds", () => {
  it("returns only the group's people with removed_at set", () => {
    const rows = [
      row("m1", "left", "left@example.com", earlier),
      row("m2", "stayed", "stayed@example.com"),
      row("m3", "elsewhere", "elsewhere@example.com", earlier, "group-2"),
    ];
    expect(removedPersonIds("group-1", rows)).toEqual(new Set(["left"]));
  });
});

import { describe, expect, it } from "vitest";
import { Group, GroupMember } from "@cyc-seattle/gsuite";
import { planGroupNestingDiscovery, planGroupUpserts } from "../src/discovery.js";
import { GoogleGroupRow } from "../src/schema.js";

function row(overrides: Partial<GoogleGroupRow>): GoogleGroupRow {
  return {
    id: "group",
    email: "group@cyccommunitysailing.org",
    name: null,
    description: null,
    settings_template: null,
    parent_id: null,
    archived: false,
    ...overrides,
  };
}

describe("planGroupUpserts", () => {
  it("creates a row for a live group with no matching google_groups row", () => {
    const live: Group = { id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" };

    const { toCreate, toUpdate } = planGroupUpserts([live], []);

    expect(toCreate).toEqual([
      {
        email: "staff@cyccommunitysailing.org",
        name: "Staff",
        description: null,
        settings_template: null,
        parent_id: null,
        archived: false,
      },
    ]);
    expect(toUpdate).toEqual([]);
  });

  it("refreshes an existing row's name when it drifted, and keeps its staff-set settings_template untouched", () => {
    const live: Group = { id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff (renamed)" };
    const existing = row({
      id: "row-1",
      email: "staff@cyccommunitysailing.org",
      name: "Staff",
      settings_template: "participants",
    });

    const { toCreate, toUpdate } = planGroupUpserts([live], [existing]);

    expect(toCreate).toEqual([]);
    expect(toUpdate).toEqual([{ id: "row-1", patch: { name: "Staff (renamed)" } }]);
  });

  it("refreshes an existing row's description when it drifted", () => {
    const live: Group = {
      id: "live-1",
      email: "staff@cyccommunitysailing.org",
      name: "Staff",
      description: "All staff",
    };
    const existing = row({ id: "row-1", email: "staff@cyccommunitysailing.org", name: "Staff", description: null });

    const { toUpdate } = planGroupUpserts([live], [existing]);

    expect(toUpdate).toEqual([{ id: "row-1", patch: { description: "All staff" } }]);
  });

  it("leaves an existing row alone when nothing about it drifted", () => {
    const live: Group = { id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" };
    const existing = row({ id: "row-1", email: "staff@cyccommunitysailing.org", name: "Staff" });

    const { toCreate, toUpdate } = planGroupUpserts([live], [existing]);

    expect(toCreate).toEqual([]);
    expect(toUpdate).toEqual([]);
  });

  it("archives a row whose email no longer appears in the live Workspace list", () => {
    const live: Group = { id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" };
    const existing = row({ id: "row-1", email: "gone@cyccommunitysailing.org" });

    const { toCreate, toUpdate } = planGroupUpserts([live], [existing]);

    expect(toCreate).toEqual([
      {
        email: "staff@cyccommunitysailing.org",
        name: "Staff",
        description: null,
        settings_template: null,
        parent_id: null,
        archived: false,
      },
    ]);
    expect(toUpdate).toEqual([{ id: "row-1", patch: { archived: true } }]);
  });

  it("doesn't re-archive a row that's already archived", () => {
    const existing = row({ id: "row-1", email: "gone@cyccommunitysailing.org", archived: true });

    const { toUpdate } = planGroupUpserts([{ id: "live-1", email: "staff@cyccommunitysailing.org" }], [existing]);

    expect(toUpdate).toEqual([]);
  });

  it("unarchives a row whose group is live again, keeping its settings_template and parent_id", () => {
    const live: Group = { id: "live-1", email: "back@cyccommunitysailing.org", name: "Back" };
    const existing = row({
      id: "row-1",
      email: "back@cyccommunitysailing.org",
      name: "Back",
      archived: true,
      settings_template: "participants",
      parent_id: "parent-1",
    });

    const { toCreate, toUpdate } = planGroupUpserts([live], [existing]);

    expect(toCreate).toEqual([]);
    expect(toUpdate).toEqual([{ id: "row-1", patch: { archived: false } }]);
  });

  it("throws rather than archive every row when the live Workspace list is empty", () => {
    const existing = row({ id: "row-1", email: "staff@cyccommunitysailing.org" });

    expect(() => planGroupUpserts([], [existing])).toThrow();
  });
});

describe("planGroupNestingDiscovery", () => {
  function member(overrides: Partial<GroupMember>): GroupMember {
    return { email: "member@cyccommunitysailing.org", role: "MEMBER", ...overrides };
  }

  it("sets a child's parent_id from a GROUP-typed member of the parent's live membership", () => {
    const parent = row({ id: "program-1", email: "program@cyccommunitysailing.org", parent_id: null });
    const child = row({ id: "class-1", email: "class@cyccommunitysailing.org", parent_id: null });
    const membersByEmail = new Map<string, readonly GroupMember[]>([
      ["program@cyccommunitysailing.org", [member({ email: "class@cyccommunitysailing.org", type: "GROUP" })]],
    ]);

    const patches = planGroupNestingDiscovery([parent, child], membersByEmail);

    expect(patches).toEqual([{ id: "class-1", patch: { parent_id: "program-1" } }]);
  });

  it("ignores a USER-typed member - only a GROUP-typed one is a sub-group", () => {
    const parent = row({ id: "program-1", email: "program@cyccommunitysailing.org" });
    const membersByEmail = new Map<string, readonly GroupMember[]>([
      ["program@cyccommunitysailing.org", [member({ email: "person@example.com", type: "USER" })]],
    ]);

    const patches = planGroupNestingDiscovery([parent], membersByEmail);

    expect(patches).toEqual([]);
  });

  it("produces no patch when the discovered parent already matches the stored parent_id", () => {
    const parent = row({ id: "program-1", email: "program@cyccommunitysailing.org" });
    const child = row({ id: "class-1", email: "class@cyccommunitysailing.org", parent_id: "program-1" });
    const membersByEmail = new Map<string, readonly GroupMember[]>([
      ["program@cyccommunitysailing.org", [member({ email: "class@cyccommunitysailing.org", type: "GROUP" })]],
    ]);

    const patches = planGroupNestingDiscovery([parent, child], membersByEmail);

    expect(patches).toEqual([]);
  });

  it("leaves a stored parent_id alone when live membership resolves no parent for it", () => {
    // class-1's parent_id was set by hand, but the nesting write pass hasn't added it to the
    // parent group on Workspace yet - discovery must not null this out before that pass runs.
    const child = row({ id: "class-1", email: "class@cyccommunitysailing.org", parent_id: "program-1" });

    const patches = planGroupNestingDiscovery([child], new Map());

    expect(patches).toEqual([]);
  });
});

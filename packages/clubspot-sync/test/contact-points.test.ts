import { describe, it, expect } from "vitest";
import type { ContactPointWithParticipant } from "@cyc-seattle/clubspot";
import {
  contactPointCandidatesFromSlots,
  ContactPointCandidateWithParticipant,
  contactPointKeySet,
  planContactPointUpserts,
  planStaffContactPoints,
} from "../src/contact-points.js";

const now = new Date("2026-01-15T00:00:00Z");

function existingPoint(overrides: Partial<ContactPointWithParticipant> = {}): ContactPointWithParticipant {
  return {
    id: "point-1",
    person_id: "person-1",
    kind: "email",
    value: "alex@example.com",
    normalized: "alex@example.com",
    source: "form",
    last_seen_at: "2025-01-01T00:00:00.000Z",
    participant_id: "participant-old",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ContactPointCandidateWithParticipant> = {},
): ContactPointCandidateWithParticipant {
  return {
    personId: "person-1",
    kind: "email",
    value: "alex@example.com",
    participantId: "participant-1",
    ...overrides,
  };
}

describe("contactPointCandidatesFromSlots", () => {
  it("drops a slot with no person, and empty values within a resolved slot", () => {
    const candidates = contactPointCandidatesFromSlots([
      { personId: null, email: "orphan@example.com", phone: "2065550100" },
      { personId: "person-1", email: null, phone: null },
    ]);

    expect(candidates).toEqual([]);
  });

  it("attributes a guardian slot's values to the guardian's own person id, not the minor's", () => {
    const candidates = contactPointCandidatesFromSlots([
      { personId: "minor-1", email: "minor@example.com", phone: null },
      { personId: "guardian-1", email: "guardian@example.com", phone: "2065550100" },
    ]);

    expect(candidates).toEqual([
      { personId: "minor-1", kind: "email", value: "minor@example.com" },
      { personId: "guardian-1", kind: "email", value: "guardian@example.com" },
      { personId: "guardian-1", kind: "phone", value: "2065550100" },
    ]);
  });
});

describe("planContactPointUpserts", () => {
  it("creates a new contact point for a value with no matching row", () => {
    const plan = planContactPointUpserts([candidate()], [], now);

    expect(plan.toUpdate).toEqual([]);
    expect(plan.skipped).toBe(0);
    expect(plan.toCreate).toEqual([
      {
        person_id: "person-1",
        kind: "email",
        value: "alex@example.com",
        normalized: "alex@example.com",
        source: "form",
        last_seen_at: now.toISOString(),
        participant_id: "participant-1",
      },
    ]);
  });

  it("touches only last_seen_at and participant_id on an existing point, leaving its value and source alone", () => {
    const existing = existingPoint({ source: "staff", value: "Alex@Example.com" });

    const plan = planContactPointUpserts([candidate({ participantId: "participant-2" })], [existing], now);

    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([
      { id: "point-1", patch: { last_seen_at: now.toISOString(), participant_id: "participant-2" } },
    ]);
  });

  it("collapses two candidates that land on the same (person, kind, normalized) key within one batch", () => {
    const plan = planContactPointUpserts(
      [candidate({ participantId: "participant-1" }), candidate({ participantId: "participant-2" })],
      [],
      now,
    );

    expect(plan.toCreate).toHaveLength(1);
  });

  it("skips a value that normalizes to nothing, and an implausible email, counting both", () => {
    const plan = planContactPointUpserts(
      [
        candidate({ kind: "phone", value: "   " }),
        candidate({ kind: "email", value: "not an email" }),
        candidate({ personId: "person-2", value: "still-good@example.com" }),
      ],
      [],
      now,
    );

    expect(plan.skipped).toBe(2);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.person_id).toBe("person-2");
  });
});

describe("contactPointKeySet and planStaffContactPoints", () => {
  it("adds a staff row only for a primary value with no contact point yet", () => {
    const existingKeys = contactPointKeySet([existingPoint({ person_id: "person-1", kind: "email" })]);

    const rows = planStaffContactPoints(
      [
        { id: "person-1", email: "alex@example.com", phone: "2065550100" },
        { id: "person-2", email: null, phone: null },
      ],
      existingKeys,
      now,
    );

    expect(rows).toEqual([
      {
        person_id: "person-1",
        kind: "phone",
        value: "2065550100",
        normalized: "2065550100",
        source: "staff",
        last_seen_at: now.toISOString(),
        participant_id: null,
      },
    ]);
  });

  it("adds nothing for a person with neither an email nor a phone", () => {
    const rows = planStaffContactPoints([{ id: "person-3", email: null, phone: null }], new Set(), now);

    expect(rows).toEqual([]);
  });
});

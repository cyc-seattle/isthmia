import { describe, it, expect, vi } from "vitest";
import winston from "winston";
import { ParticipantRow } from "@cyc-seattle/clubspot";
import { planParticipantLinks } from "../src/participants.js";
import { RegistrationWithClubspot } from "../src/schema.js";

function registration(overrides: Partial<RegistrationWithClubspot> = {}): RegistrationWithClubspot {
  return {
    id: "row-1",
    person_id: "person-1",
    participant_id: null,
    last_sync_run_id: null,
    camp_id: "camp-row-1",
    clubspot_registration_id: "reg-1",
    registered_at: "2026-01-01T00:00:00Z",
    status: "confirmed",
    waiver_status: null,
    archived: false,
    clubspot_participant_id: "participant-1",
    ...overrides,
  };
}

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    person_id: "person-1",
    last_sync_run_id: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    guardian_1_name: null,
    guardian_1_email: null,
    guardian_1_mobile: null,
    guardian_2_name: null,
    guardian_2_email: null,
    guardian_2_mobile: null,
    emergency_1_name: null,
    emergency_1_phone: null,
    emergency_1_email: null,
    emergency_1_relationship: null,
    emergency_2_name: null,
    emergency_2_phone: null,
    emergency_2_email: null,
    emergency_2_relationship: null,
    medical_conditions: null,
    medical_allergies: null,
    medical_medications: null,
    medical_last_tetanus: null,
    medical_physician_name: null,
    medical_physician_phone: null,
    medical_weight: null,
    ...overrides,
  };
}

describe("planParticipantLinks", () => {
  it("creates a participant and links the registration when neither exists yet", () => {
    const plan = planParticipantLinks([registration()], []);
    expect(plan.toCreate).toEqual([{ id: "participant-1", person_id: "person-1" }]);
    expect(plan.toLink).toEqual([{ registrationId: "row-1", participantId: "participant-1" }]);
    expect(plan.unlinkable).toBe(0);
  });

  it("reuses an existing participant and links the registration, without touching the participant's person_id", () => {
    const existing = participant({ person_id: "some-other-person" });
    const plan = planParticipantLinks([registration({ person_id: "person-1" })], [existing]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toLink).toEqual([{ registrationId: "row-1", participantId: "participant-1" }]);
  });

  it("leaves an already-linked registration alone", () => {
    const plan = planParticipantLinks([registration({ participant_id: "participant-1" })], []);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toLink).toEqual([]);
  });

  it("counts and warns once for registrations with no clubspot_participant_id or no person_id", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const registrations = [
        registration({ id: "row-1", clubspot_registration_id: "reg-1", clubspot_participant_id: null }),
        registration({ id: "row-2", clubspot_registration_id: "reg-2", person_id: null }),
        registration({ id: "row-3", clubspot_registration_id: "reg-3" }),
      ];
      const plan = planParticipantLinks(registrations, []);
      expect(plan.unlinkable).toBe(2);
      expect(plan.toCreate).toEqual([{ id: "participant-1", person_id: "person-1" }]);
      expect(plan.toLink).toEqual([{ registrationId: "row-3", participantId: "participant-1" }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("2"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("creates only one participant row when two registrations share a participant", () => {
    const registrations = [
      registration({ id: "row-1", clubspot_registration_id: "reg-1" }),
      registration({ id: "row-2", clubspot_registration_id: "reg-2" }),
    ];
    const plan = planParticipantLinks(registrations, []);
    expect(plan.toCreate).toEqual([{ id: "participant-1", person_id: "person-1" }]);
    expect(plan.toLink).toEqual([
      { registrationId: "row-1", participantId: "participant-1" },
      { registrationId: "row-2", participantId: "participant-1" },
    ]);
  });

  it("is idempotent: a second pass over the same rows changes nothing", () => {
    const existing = participant();
    const linked = registration({ participant_id: "participant-1" });
    const plan = planParticipantLinks([linked], [existing]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toLink).toEqual([]);
    expect(plan.unlinkable).toBe(0);
  });
});

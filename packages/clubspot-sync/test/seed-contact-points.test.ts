import { describe, it, expect, vi, afterEach } from "vitest";
import { ContactRow } from "@cyc-seattle/crm";
import { ContactPointWithParticipant, ParticipantRow } from "@cyc-seattle/clubspot";
import { DirectusClient } from "@cyc-seattle/directus";
import { seedContactPoints, slotsForMirroredParticipant } from "../src/seed-contact-points.js";

const baseUrl = "https://directus.example.com";
const token = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function participant(overrides: Partial<ParticipantRow> & { id: string; person_id: string }): ParticipantRow {
  return {
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

function contact(overrides: Partial<ContactRow> & { subject_id: string; contact_id: string }): ContactRow {
  return { relationship_type: "guardian", contact_order: 1, relationship_detail: null, ...overrides };
}

describe("slotsForMirroredParticipant", () => {
  it("attributes each guardian and emergency slot to the person its contacts row resolved to", () => {
    const mirrored = participant({
      id: "cs-participant-1",
      person_id: "minor-1",
      email: "minor@example.com",
      guardian_1_email: "guardian@example.com",
      guardian_1_mobile: "2065550100",
      emergency_1_phone: "2065550199",
    });
    const contacts: ContactRow[] = [
      contact({ subject_id: "minor-1", contact_id: "guardian-1", relationship_type: "guardian", contact_order: 1 }),
      contact({
        subject_id: "minor-1",
        contact_id: "emergency-1",
        relationship_type: "emergency_contact",
        contact_order: 1,
      }),
    ];

    const slots = slotsForMirroredParticipant(mirrored, contacts);

    expect(slots).toEqual([
      { personId: "minor-1", email: "minor@example.com", phone: null },
      { personId: "guardian-1", email: "guardian@example.com", phone: "2065550100" },
      { personId: null, email: null, phone: null },
      { personId: "emergency-1", email: null, phone: "2065550199" },
      { personId: null, email: null, phone: null },
    ]);
  });

  it("produces no slots for a participant with no linked person", () => {
    expect(slotsForMirroredParticipant(participant({ id: "cs-participant-2", person_id: "" }), [])).toEqual([]);
  });
});

describe("seedContactPoints", () => {
  it("backfills contact_points from the mirror, then adds a staff row for an uncovered primary", async () => {
    const participants = [
      participant({ id: "cs-p1", person_id: "person-1", email: "alex@example.com" }),
      // Already has a contact_points row for this value - the form pass should only touch it.
      participant({ id: "cs-p2", person_id: "person-2", email: "jordan@example.com" }),
    ];
    const existingContactPoint: ContactPointWithParticipant = {
      id: "cp-1",
      person_id: "person-2",
      kind: "email",
      value: "jordan@example.com",
      normalized: "jordan@example.com",
      source: "form",
      last_seen_at: "2025-01-01T00:00:00.000Z",
      participant_id: "cs-old",
    };
    const people = [
      { id: "person-1", email: "alex@example.com", phone: null },
      { id: "person-2", email: "jordan@example.com", phone: null },
      // No participant ever gave this - it should get a staff row.
      { id: "person-3", email: "staff-added@example.com", phone: null },
    ];

    let nextId = 1;
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        return jsonResponse(200, { data: JSON.parse(init!.body as string) });
      }
      if (method === "POST") {
        const items = JSON.parse(init!.body as string) as Record<string, unknown>[];
        return jsonResponse(200, { data: items.map((item) => ({ id: `generated-${nextId++}`, ...item })) });
      }
      if (url.includes("/items/participants")) {
        return jsonResponse(200, { data: participants });
      }
      if (url.includes("/items/contacts")) {
        return jsonResponse(200, { data: [] });
      }
      if (url.includes("/items/contact_points")) {
        return jsonResponse(200, { data: [existingContactPoint] });
      }
      if (url.includes("/items/people")) {
        return jsonResponse(200, { data: people });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directus = new DirectusClient(baseUrl, token);
    const result = await seedContactPoints(directus, new Date("2026-01-15T00:00:00Z"));

    expect(result).toEqual({
      participantsProcessed: 2,
      formContactPointsCreated: 1,
      formContactPointsTouched: 1,
      formValuesSkipped: 0,
      staffContactPointsCreated: 1,
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([, init]: [string, { method?: string } | undefined]) => init?.method === "POST",
    );
    expect(postCalls).toHaveLength(2);
    const [, formCreateInit] = postCalls[0] as [string, { body: string }];
    expect(JSON.parse(formCreateInit.body)).toEqual([
      expect.objectContaining({ person_id: "person-1", kind: "email", value: "alex@example.com", source: "form" }),
    ]);
    const [, staffCreateInit] = postCalls[1] as [string, { body: string }];
    expect(JSON.parse(staffCreateInit.body)).toEqual([
      expect.objectContaining({
        person_id: "person-3",
        kind: "email",
        value: "staff-added@example.com",
        source: "staff",
      }),
    ]);
  });
});

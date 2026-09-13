import { describe, it, expect, vi, afterEach } from "vitest";
import type { Participant } from "@cyc-seattle/clubspot-sdk";
import { DirectusClient } from "../src/directus.js";
import { PersonSync } from "../src/person-sync.js";

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

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor, per roster.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function participant(data: Record<string, unknown>) {
  return parseObject("participant-1", data) as unknown as Participant;
}

describe("PersonSync.syncParticipant", () => {
  it("creates the participant's person, medical profile, and guardian contact when nothing exists yet", async () => {
    const fetchMock = vi
      .fn()
      // 1. candidate fetch for the participant
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      // 2. create the participant's people row
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "person-1" }] }))
      // 3. existing medical_profiles row for person-1
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      // 4. create the medical_profiles row
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "mp-1" }] }))
      // 5. existing guardian contacts for person-1
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      // 6. candidate fetch for the guardian
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      // 7. create the guardian's people row
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "guardian-1" }] }))
      // 8. create the guardian's contacts row
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "contact-1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    const resolved = await sync.syncParticipant(
      participant({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.com",
        DOB: new Date("2015-04-01T00:00:00Z"),
        parentGuardianName: "Robert Smith",
        parentGuardianEmail: "robert@example.com",
        parentGuardianMobile: "2065550100",
      }),
    );

    expect(resolved).toEqual({ id: "person-1", created: true });
    expect(fetchMock).toHaveBeenCalledTimes(8);

    const [, createPersonInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(createPersonInit.body as string)).toEqual([
      expect.objectContaining({ first_name: "Alex", last_name: "Rivera", email: "alex@example.com" }),
    ]);

    const [contactsUrl, createContactInit] = fetchMock.mock.calls[7] as [string, RequestInit];
    expect(contactsUrl).toBe(`${baseUrl}/items/contacts`);
    expect(JSON.parse(createContactInit.body as string)).toEqual([
      {
        related_person_id: "person-1",
        person_id: "guardian-1",
        relationship_type: "guardian",
        contact_order: 1,
        relationship_detail: null,
      },
    ]);
  });

  it("fills gaps on a matched person without overwriting an existing value", async () => {
    const existingPerson = {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: null,
      phone: "2065550100",
      date_of_birth: "2015-04-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingPerson] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: existingPerson }))
      // medical_profiles: none yet
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "mp-1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    const resolved = await sync.syncParticipant(
      participant({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.com",
        mobile: "9999999999",
        DOB: new Date("2015-04-01T00:00:00Z"),
      }),
    );

    expect(resolved).toEqual({ id: "person-1", created: false });

    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toBe(`${baseUrl}/items/people/person-1`);
    expect(patchInit.method).toBe("PATCH");
    // email was null on the existing row, so it's filled; phone already had a value, so it's left alone.
    expect(JSON.parse(patchInit.body as string)).toEqual({ email: "alex@example.com" });
  });

  // The regression test for the merge-durability rule: a contacts row already exists for this
  // minor and order, so its person_id must survive the run untouched - no candidate fetch, no
  // write to `contacts` or a different `people` row.
  it("leaves an existing contact's person_id alone even though the matcher would now choose differently", async () => {
    const existingPerson = {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "alex@example.com",
      phone: "2065550100",
      date_of_birth: "2015-04-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
    const existingMedicalProfile = {
      id: "mp-1",
      person_id: "person-1",
      allergies: null,
      medications: null,
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const existingGuardianContact = {
      id: "contact-1",
      related_person_id: "person-1",
      person_id: "some-other-person",
      relationship_type: "guardian",
      contact_order: 1,
      relationship_detail: null,
    };

    const fetchMock = vi
      .fn()
      // participant candidate fetch: matches the existing person, and every field is already filled
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingPerson] }))
      // medical_profiles: already exists with nothing left to fill
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingMedicalProfile] }))
      // guardian contacts: a row already exists for order 1
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingGuardianContact] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    const resolved = await sync.syncParticipant(
      participant({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.com",
        DOB: new Date("2015-04-01T00:00:00Z"),
        parentGuardianName: "Robert Smith",
        parentGuardianEmail: "robert@example.com",
      }),
    );

    expect(resolved).toEqual({ id: "person-1", created: false });
    // Three reads and nothing else: no candidate fetch for the guardian, no write to `contacts`,
    // no write to any `people` row.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });
});

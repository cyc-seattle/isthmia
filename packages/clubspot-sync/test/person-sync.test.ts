import { describe, it, expect, vi, afterEach } from "vitest";
import winston from "winston";
import type { Participant } from "@cyc-seattle/clubspot-sdk";
import { DirectusClient } from "@cyc-seattle/directus";
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
        subject_id: "person-1",
        contact_id: "guardian-1",
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

  it("finds a stored person whose email differs only by case, instead of creating a duplicate", async () => {
    const existingPerson = {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      // Clubspot sent this with capitals on an earlier registration, and it was stored verbatim.
      email: "Alex@Example.com",
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
        DOB: new Date("2015-04-01T00:00:00Z"),
      }),
    );

    // Matched, not created. An `_eq` candidate fetch would have missed the row entirely.
    expect(resolved).toEqual({ id: "person-1", created: false });

    const [candidateUrl] = fetchMock.mock.calls[0] as [string];
    expect(candidateUrl).toContain("filter%5Bemail%5D%5B_icontains%5D=alex%40example.com");
  });

  // The regression test for the merge-durability rule: a contacts row already exists for this
  // minor and order, so its contact_id must survive the run untouched - no candidate fetch, no
  // write to `contacts` or a different `people` row.
  it("leaves an existing contact's contact_id alone even though the matcher would now choose differently", async () => {
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
      subject_id: "person-1",
      contact_id: "some-other-person",
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

  // The regression test for finding 3: a registration already points at person-1, so that id is
  // reused even though the matcher - given the corrected name below - would now choose a different
  // person or create a new one. This is what keeps the registration and the freshly synced medical
  // profile pointing at the same person.
  it("reuses the given person id and skips matching, even though the matcher would now choose differently", async () => {
    const fetchMock = vi
      .fn()
      // reusePerson's lookup of person-1 by id - not the candidate search a match would run
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "mp-1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    const resolved = await sync.syncParticipant(
      // Staff corrected "Jon" to "John" in Clubspot; a fresh match would fail on first name and
      // either miss person-1 entirely or land on an unrelated candidate.
      participant({ firstName: "John", lastName: "Smith", DOB: new Date("2015-04-01T00:00:00Z") }),
      "person-1",
    );

    expect(resolved).toEqual({ id: "person-1", created: false });
    const [lookupUrl] = fetchMock.mock.calls[0] as [string];
    expect(lookupUrl).toContain("filter%5Bid%5D%5B_eq%5D=person-1");
    expect(lookupUrl).not.toContain("last_name");
    expect(lookupUrl).not.toContain("email");
  });

  // The regression test for finding 5: "Le" is a substring of dozens of last names, so the
  // candidate fetch hits its cap before the real "Le" row - if there is one - ever gets fetched.
  // Silently creating a person here would risk a duplicate with its own medical profile.
  it("warns when the last-name candidate search hits the limit with no match, since a real match may be beyond it", async () => {
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      id: `candidate-${i}`,
      first_name: "Someone",
      last_name: "Le",
      email: null,
      phone: null,
      date_of_birth: "2000-01-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    }));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: candidates }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "person-new" }] }))
      // medical_profiles: none yet
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "mp-1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const sync = new PersonSync(new DirectusClient(baseUrl, token));
      const resolved = await sync.syncParticipant(
        participant({ firstName: "Kim", lastName: "Le", DOB: new Date("2015-04-01T00:00:00Z") }),
      );

      expect(resolved).toEqual({ id: "person-new", created: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Le"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("PersonSync.syncParticipant - dry run", () => {
  it("resolves a newly created person to a placeholder id instead of throwing", async () => {
    const fetchMock = vi
      .fn()
      // candidate fetch for the participant
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      // existing medical_profiles for the placeholder person id
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token, true));
    const resolved = await sync.syncParticipant(
      participant({ firstName: "Alex", lastName: "Rivera", DOB: new Date("2015-04-01T00:00:00Z") }),
    );

    expect(resolved.created).toBe(true);
    expect(resolved.id).toEqual(expect.any(String));
    expect(resolved.id.length).toBeGreaterThan(0);
    // Only the two reads above: dry-run writes never reach fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still throws when a real run's create doesn't return an id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{}] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    await expect(sync.syncParticipant(participant({ firstName: "Alex", lastName: "Rivera" }))).rejects.toThrow(
      "Directus did not return the created people row",
    );
  });
});

describe("PersonSync.syncParticipant - medical_profiles", () => {
  const existingProfile = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: "mp-1",
    person_id: "person-1",
    allergies: null,
    medications: null,
    conditions: null,
    physician_name: null,
    physician_phone: null,
    last_tetanus: null,
    weight: null,
    ...overrides,
  });

  it("updates a value Clubspot changed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] })) // reusePerson lookup, no row to fill gaps on
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingProfile({ allergies: "peanuts" })] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: existingProfile({ allergies: "peanuts, bee stings" }) }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    await sync.syncParticipant(
      participant({ firstName: "Alex", medical_allergies: "peanuts, bee stings" }),
      "person-1",
    );

    const [patchUrl, patchInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(patchUrl).toBe(`${baseUrl}/items/medical_profiles/mp-1`);
    expect(JSON.parse(patchInit.body as string)).toEqual({ allergies: "peanuts, bee stings" });
  });

  it("writes nothing when Clubspot's values match the stored profile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingProfile({ allergies: "peanuts" })] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    await sync.syncParticipant(participant({ firstName: "Alex", medical_allergies: "peanuts" }), "person-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("clears a value Clubspot no longer has, instead of leaving it stuck", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [existingProfile({ allergies: "peanuts" })] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: existingProfile({ allergies: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    // No medical_allergies at all this time - the guardian retracted it in Clubspot.
    await sync.syncParticipant(participant({ firstName: "Alex" }), "person-1");

    const [patchUrl, patchInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(patchUrl).toBe(`${baseUrl}/items/medical_profiles/mp-1`);
    expect(JSON.parse(patchInit.body as string)).toEqual({ allergies: null });
  });
});

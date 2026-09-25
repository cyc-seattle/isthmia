import { describe, it, expect, vi, afterEach } from "vitest";
import winston from "winston";
import type { Participant } from "@cyc-seattle/clubspot-sdk";
import { ParticipantRow } from "@cyc-seattle/clubspot";
import { DirectusClient } from "@cyc-seattle/directus";
import { buildParticipantMirrorFields, ParticipantMirrorFields } from "../src/people.js";
import { PersonSync, SyncParticipantOptions } from "../src/person-sync.js";
import { RegistrationRank } from "../src/synced-fields.js";

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

type FetchInit = { method?: string; body?: unknown };

/**
 * A stateful in-memory Directus stand-in, same shape as `sync-run.test.ts`'s - GET applies
 * `_eq`, `_neq`, and `_in` against a per-collection table that POST/PATCH actually mutate. `_in`
 * matters here specifically: `isNewestParticipant`'s sibling query finds the person's other
 * participants, then their registrations, by id list.
 */
function makeDirectusStore(seed: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>(
    Object.entries(seed).map(([collection, rows]) => [collection, (rows ?? []).map((row) => ({ ...row }))]),
  );
  let nextId = 1;

  function table(collection: string): Record<string, unknown>[] {
    if (!tables.has(collection)) {
      tables.set(collection, []);
    }
    return tables.get(collection)!;
  }

  function matchesFilter(row: Record<string, unknown>, search: URLSearchParams): boolean {
    for (const [key, value] of search.entries()) {
      const eqMatch = /^filter\[([^\]]+)\]\[_eq\]$/.exec(key);
      if (eqMatch) {
        if (String(row[eqMatch[1]!] ?? "") !== value) {
          return false;
        }
        continue;
      }
      const neqMatch = /^filter\[([^\]]+)\]\[_neq\]$/.exec(key);
      if (neqMatch) {
        if (String(row[neqMatch[1]!] ?? "") === value) {
          return false;
        }
        continue;
      }
      const inMatch = /^filter\[([^\]]+)\]\[_in\]$/.exec(key);
      if (inMatch) {
        if (!value.split(",").includes(String(row[inMatch[1]!] ?? ""))) {
          return false;
        }
      }
    }
    return true;
  }

  const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const [, , collection, id] = parsed.pathname.split("/");

    if (method === "GET") {
      const rows = table(collection!).filter((row) => matchesFilter(row, parsed.searchParams));
      return jsonResponse(200, { data: rows });
    }
    if (method === "POST") {
      const items = JSON.parse(init!.body as string) as Record<string, unknown>[];
      const created = items.map((item) => ({ id: `generated-${nextId++}`, ...item }));
      table(collection!).push(...created);
      return jsonResponse(200, { data: created });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(init!.body as string) as Record<string, unknown>;
      const rows = table(collection!);
      const index = rows.findIndex((row) => row["id"] === id);
      if (index === -1) {
        return jsonResponse(200, { data: patch });
      }
      rows[index] = { ...rows[index], ...patch };
      return jsonResponse(200, { data: rows[index] });
    }
    return jsonResponse(204, undefined);
  });

  return { fetchMock, tables };
}

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor, per roster.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function participant(data: Record<string, unknown>, id = "participant-1") {
  return parseObject(id, data) as unknown as Participant;
}

function rank(id: string, archived: boolean, registeredAt: string): RegistrationRank {
  return { id, archived, registered_at: registeredAt };
}

/** The full mirror `syncRegistrations` would build for this participant - see `people.ts`. */
function mirrorFieldsFor(data: Record<string, unknown>, id = "participant-1"): ParticipantMirrorFields {
  return buildParticipantMirrorFields(participant(data, id));
}

const emptyMirror: ParticipantMirrorFields = mirrorFieldsFor({});

/** A stored `participants` row, filled in with `emptyMirror` for every field this test doesn't care about. */
function participantRow(overrides: Partial<ParticipantRow> & { id: string; person_id: string }): ParticipantRow {
  return { last_sync_run_id: null, ...emptyMirror, ...overrides };
}

function options(overrides: Partial<SyncParticipantOptions> = {}): SyncParticipantOptions {
  return {
    mirrorFields: mirrorFieldsFor({ firstName: "Alex", lastName: "Rivera" }),
    registration: rank("reg-1", false, "2026-01-10T00:00:00Z"),
    ...overrides,
  };
}

describe("PersonSync.syncParticipant - creating and matching", () => {
  it("creates the participant's person, medical profile, and guardian contact when nothing exists yet", async () => {
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const data = {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.com",
      DOB: new Date("2015-04-01T00:00:00Z"),
      parentGuardianName: "Robert Smith",
      parentGuardianEmail: "robert@example.com",
      parentGuardianMobile: "2065550100",
    };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved.created).toBe(true);
    expect(resolved.contactPointsCreated).toBe(3);

    const people = tables.get("people") ?? [];
    expect(people).toHaveLength(2); // the minor, and the guardian
    expect(people).toContainEqual(
      expect.objectContaining({ first_name: "Alex", last_name: "Rivera", email: "alex@example.com" }),
    );

    const contacts = tables.get("contacts") ?? [];
    expect(contacts).toEqual([
      expect.objectContaining({
        subject_id: resolved.id,
        relationship_type: "guardian",
        contact_order: 1,
      }),
    ]);

    const contactPoints = tables.get("contact_points") ?? [];
    expect(contactPoints).toHaveLength(3);
    expect(contactPoints).toContainEqual(expect.objectContaining({ kind: "email", value: "robert@example.com" }));
  });

  it("fills gaps on a matched person without overwriting an existing value, when the participant has never been mirrored before", async () => {
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
    const { fetchMock, tables } = makeDirectusStore({ people: [existingPerson] });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const data = {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.com",
      mobile: "9999999999",
      DOB: new Date("2015-04-01T00:00:00Z"),
    };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved).toMatchObject({ id: "person-1", created: false });
    // email was null on the existing row, so it's filled; phone already had a value, so it's left alone.
    expect(tables.get("people")![0]).toMatchObject({ email: "alex@example.com", phone: "2065550100" });
  });

  it("finds a stored person through a secondary email in contact_points, instead of creating a duplicate", async () => {
    const existingPerson = {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "primary@example.com",
      phone: null,
      date_of_birth: null,
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
    const existingContactPoint = {
      id: "cp-1",
      person_id: "person-1",
      kind: "email",
      value: "secondary@example.com",
      normalized: "secondary@example.com",
      source: "form",
      last_seen_at: "2025-01-01T00:00:00.000Z",
      participant_id: "participant-old",
    };
    const { fetchMock, tables } = makeDirectusStore({
      people: [existingPerson],
      contact_points: [existingContactPoint],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    // No DOB, so matchParticipant requires an email match, and the candidate fetch is by email.
    const data = { firstName: "Alex", lastName: "Rivera", email: "secondary@example.com" };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved).toMatchObject({
      id: "person-1",
      created: false,
      contactPointsCreated: 0,
      contactPointsTouched: 1,
    });
    // Its value and source stay put - a value already on file never becomes reclaimed as `form` -
    // but this run's touch bumps last_seen_at and re-attributes the participant that used it.
    expect(tables.get("contact_points")).toEqual([
      { ...existingContactPoint, last_seen_at: expect.any(String), participant_id: "participant-1" },
    ]);
  });

  // Regression test for the Felix Lenz / Shea Nicholas / Max McCredy duplicates: the same child
  // registered by a different parent has a different email, but matchParticipant matches on name
  // and DOB once a DOB is known - the candidate fetch has to find the row without email's help.
  it("finds a stored person with the same name and date of birth registered under a different email", async () => {
    const existingPerson = {
      id: "person-1",
      first_name: "Felix",
      last_name: "Lenz",
      email: "parent-a@example.com",
      phone: null,
      date_of_birth: "2010-05-03",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
    const { fetchMock, tables } = makeDirectusStore({ people: [existingPerson] });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const data = {
      firstName: "Felix",
      lastName: "Lenz",
      email: "parent-b@example.com",
      mobile: "2065559999",
      DOB: new Date("2010-05-03T00:00:00Z"),
    };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved).toMatchObject({ id: "person-1", created: false });
    // Phone was the only gap on the matched row; the new email is left alone rather than
    // overwriting the family's stored contact.
    expect(tables.get("people")![0]).toMatchObject({ phone: "2065559999", email: "parent-a@example.com" });
  });

  // The regression test for the merge-durability rule: a contacts row already exists for this
  // minor and order, so its contact_id must survive the run untouched.
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
    const existingGuardian = {
      id: "some-other-person",
      first_name: "Robert",
      last_name: "Smith",
      email: "robert@example.com",
      phone: null,
      date_of_birth: null,
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
    const existingGuardianContact = {
      id: "contact-1",
      subject_id: "person-1",
      contact_id: "some-other-person",
      relationship_type: "guardian",
      contact_order: 1,
      relationship_detail: null,
    };
    const { fetchMock, tables } = makeDirectusStore({
      people: [existingPerson, existingGuardian],
      contacts: [existingGuardianContact],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    // Same guardian name and email as already on file, so the slot's own field rule writes
    // nothing either - this test is purely about the contact_id staying put.
    const data = {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.com",
      DOB: new Date("2015-04-01T00:00:00Z"),
      parentGuardianName: "Robert Smith",
      parentGuardianEmail: "robert@example.com",
    };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved.id).toBe("person-1");
    expect(tables.get("contacts")).toEqual([existingGuardianContact]);
    expect(tables.get("people")).toEqual([existingPerson, existingGuardian]);
  });

  // The regression test for finding 3: a registration already points at person-1, so that id is
  // reused even though the matcher - given the corrected name below - would now choose a
  // different, wrong person.
  it("reuses the given person id and skips matching, even though the matcher would now choose differently", async () => {
    const wrongMatch = {
      id: "wrong-match",
      first_name: "John",
      last_name: "Smith",
      email: null,
      phone: null,
      date_of_birth: "2015-04-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
    const { fetchMock, tables } = makeDirectusStore({ people: [wrongMatch] });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    // Staff corrected "Jon" to "John" in Clubspot; a fresh match would land on wrong-match instead.
    const data = { firstName: "John", lastName: "Smith", DOB: new Date("2015-04-01T00:00:00Z") };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved).toMatchObject({ id: "person-1", created: false });
    // wrong-match was never touched - the pinned id short-circuited matching entirely.
    expect(tables.get("people")).toEqual([wrongMatch]);
  });

  // The regression test for finding 5: "Le" is a substring of dozens of last names, so the
  // candidate fetch hits its cap before the real "Le" row - if there is one - ever gets fetched.
  it("warns when the last-name candidate search hits the limit with no match, since a real match may be beyond it", async () => {
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      id: `candidate-${i}`,
      first_name: "Someone",
      last_name: "Le",
      email: null,
      phone: null,
      date_of_birth: null,
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    }));
    const { fetchMock, tables } = makeDirectusStore({ people: candidates });
    vi.stubGlobal("fetch", fetchMock);

    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const sync = new PersonSync(new DirectusClient(baseUrl, token));
      // No email and no DOB, so the candidate fetch falls back to a last-name substring search.
      const data = { firstName: "Kim", lastName: "Le" };
      const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

      expect(resolved.created).toBe(true);
      expect(tables.get("people")).toHaveLength(51);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Le"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("PersonSync.syncParticipant - dry run", () => {
  it("resolves a newly created person to a placeholder id instead of throwing", async () => {
    const { fetchMock } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token, true));
    const data = { firstName: "Alex", lastName: "Rivera", DOB: new Date("2015-04-01T00:00:00Z") };
    const resolved = await sync.syncParticipant(participant(data), options({ mirrorFields: mirrorFieldsFor(data) }));

    expect(resolved.created).toBe(true);
    expect(resolved.id).toEqual(expect.any(String));
    expect(resolved.id.length).toBeGreaterThan(0);
  });

  it("still throws when a real run's create doesn't return an id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{}] }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = new PersonSync(new DirectusClient(baseUrl, token));
    await expect(
      sync.syncParticipant(participant({ firstName: "Alex", lastName: "Rivera" }), options()),
    ).rejects.toThrow("Directus did not return the created people row");
  });
});

describe("PersonSync.syncParticipant - the one CRM field rule (#137)", () => {
  function seedPerson(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: null,
      phone: null,
      date_of_birth: "2015-04-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
      ...overrides,
    };
  }

  it("writes nothing when Clubspot repeats what it sent last time - unchanged", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "staff-added@example.com" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "form@example.com",
    });
    const data = { firstName: "Alex", lastName: "Rivera", email: "form@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(0);
    expect(tables.get("people")![0]).toMatchObject({ email: "staff-added@example.com" });
  });

  it("writes Clubspot's new answer over a staff edit, and counts the replacement", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "staff-added@example.com" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "form@example.com",
    });
    const data = { firstName: "Alex", lastName: "Rivera", email: "form-changed@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(1);
    expect(resolved.fieldsReplacedStaffEdits).toBe(1);
    expect(tables.get("people")![0]).toMatchObject({ email: "form-changed@example.com" });
  });

  it("writes Clubspot's new answer when nothing had replaced base yet - no staff edit to count", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "form@example.com" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "form@example.com",
    });
    const data = { firstName: "Alex", lastName: "Rivera", email: "form-changed@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(1);
    expect(resolved.fieldsReplacedStaffEdits).toBe(0);
    expect(tables.get("people")![0]).toMatchObject({ email: "form-changed@example.com" });
  });

  it("never writes a blank value, and counts it instead", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "staff-added@example.com", phone: "2065550100" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorData = { firstName: "Alex", lastName: "Rivera", email: "form@example.com" };
    const priorMirror = participantRow({ id: "participant-1", person_id: "person-1", ...mirrorFieldsFor(priorData) });
    // Clubspot no longer has an email on file for this participant. Every other field is blank on
    // both sides too - each one is its own counted, unwritten blank (`synced-fields.test.ts`
    // covers that per field); this only asserts email's own outcome.
    const data = { firstName: "Alex", lastName: "Rivera" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(0);
    expect(resolved.fieldsBlankSkipped).toBeGreaterThanOrEqual(1);
    expect(tables.get("people")![0]).toMatchObject({ email: "staff-added@example.com" });
  });

  it("fills only null columns on a participant's first mirror write, leaving an already-set column alone", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ phone: "2065550100" })], // first_name/last_name/email null on file
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    // No priorMirror: this participant has never been mirrored before, even though person-1 has.
    const data = { firstName: "Alex", lastName: "Rivera", email: "alex@example.com", mobile: "9999999999" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(1); // only email, since phone already had a value
    expect(resolved.fieldsReplacedStaffEdits).toBe(0);
    expect(tables.get("people")![0]).toMatchObject({ email: "alex@example.com", phone: "2065550100" });
  });

  it("writes nothing when an older participant syncs after a newer one is already linked", async () => {
    const newerRegistration = {
      id: "reg-newer",
      participant_id: "participant-newer",
      camp_id: "camp-a",
      registered_at: "2026-03-01T00:00:00.000Z",
      status: "confirmed",
      waiver_status: null,
      archived: false,
    };
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "staff-added@example.com" })],
      participants: [{ id: "participant-newer", person_id: "person-1" }],
      registrations: [newerRegistration],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-older",
      person_id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "form@example.com",
    });
    const data = { firstName: "Alex", lastName: "Rivera", email: "form-changed@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data, "participant-older"),
      options({
        existingPersonId: "person-1",
        priorMirror,
        mirrorFields: mirrorFieldsFor(data, "participant-older"),
        registration: rank("reg-older", false, "2026-01-01T00:00:00Z"),
      }),
    );

    expect(resolved.fieldsWritten).toBe(0);
    expect(resolved.fieldsReplacedStaffEdits).toBe(0);
    expect(resolved.fieldsBlankSkipped).toBe(0);
    expect(tables.get("people")![0]).toMatchObject({ email: "staff-added@example.com" });
  });

  it("still writes when this registration outranks every other one linked to the person", async () => {
    const olderRegistration = {
      id: "reg-older",
      participant_id: "participant-older",
      camp_id: "camp-a",
      registered_at: "2025-01-01T00:00:00.000Z",
      status: "confirmed",
      waiver_status: null,
      archived: false,
    };
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedPerson({ email: "staff-added@example.com" })],
      participants: [{ id: "participant-older", person_id: "person-1" }],
      registrations: [olderRegistration],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-newer",
      person_id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "form@example.com",
    });
    const data = { firstName: "Alex", lastName: "Rivera", email: "form-changed@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data, "participant-newer"),
      options({
        existingPersonId: "person-1",
        priorMirror,
        mirrorFields: mirrorFieldsFor(data, "participant-newer"),
        registration: rank("reg-newer", false, "2026-03-01T00:00:00Z"),
      }),
    );

    expect(resolved.fieldsWritten).toBe(1);
    expect(tables.get("people")![0]).toMatchObject({ email: "form-changed@example.com" });
  });
});

describe("PersonSync.syncParticipant - guardian and emergency-contact slots", () => {
  function seedGuardian(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "guardian-1",
      first_name: "Robert",
      last_name: "Smith",
      email: null,
      phone: null,
      date_of_birth: null,
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
      ...overrides,
    };
  }

  function seedMinor() {
    return {
      id: "person-1",
      first_name: "Alex",
      last_name: "Rivera",
      email: "alex@example.com",
      phone: null,
      date_of_birth: "2015-04-01",
      gender: null,
      street: null,
      city: null,
      state: null,
      postal_code: null,
    };
  }

  function seedGuardianContact() {
    return {
      id: "contact-1",
      subject_id: "person-1",
      contact_id: "guardian-1",
      relationship_type: "guardian",
      contact_order: 1,
      relationship_detail: null,
    };
  }

  it("writes a guardian's changed field the same way as the minor's own", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedMinor(), seedGuardian({ email: "staff-added@example.com" })],
      contacts: [seedGuardianContact()],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorData = {
      firstName: "Alex",
      lastName: "Rivera",
      DOB: new Date("2015-04-01T00:00:00Z"),
      parentGuardianName: "Robert Smith",
      parentGuardianEmail: "form@example.com",
    };
    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      ...mirrorFieldsFor(priorData),
    });
    const data = { ...priorData, parentGuardianEmail: "form-changed@example.com" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsReplacedStaffEdits).toBe(1);
    const guardian = tables.get("people")!.find((row) => row["id"] === "guardian-1");
    expect(guardian).toMatchObject({ email: "form-changed@example.com" });
  });

  it("skips a guardian slot whose name no longer matches its linked person, and counts nothing written", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [seedMinor(), seedGuardian({ email: "robert@example.com" })],
      contacts: [seedGuardianContact()],
    });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorData = {
      firstName: "Alex",
      lastName: "Rivera",
      DOB: new Date("2015-04-01T00:00:00Z"),
      parentGuardianName: "Robert Smith",
      parentGuardianEmail: "robert@example.com",
    };
    const priorMirror = participantRow({ id: "participant-1", person_id: "person-1", ...mirrorFieldsFor(priorData) });
    // Clubspot now names a completely different guardian in the same slot.
    const data = { ...priorData, parentGuardianName: "Maria Garcia", parentGuardianEmail: "maria@example.com" };

    try {
      const resolved = await sync.syncParticipant(
        participant(data),
        options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
      );

      expect(resolved.fieldsWritten).toBe(0);
      expect(resolved.slotNameMismatches).toBe(1);
      const guardian = tables.get("people")!.find((row) => row["id"] === "guardian-1");
      expect(guardian).toMatchObject({ email: "robert@example.com" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer matches"), expect.anything());
    } finally {
      warn.mockRestore();
    }
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

  it("creates a profile from scratch when this person has none yet", async () => {
    const { fetchMock, tables } = makeDirectusStore({ people: [{ id: "person-1", first_name: "Alex" }] });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const data = { firstName: "Alex", medical_allergies: "peanuts" };
    await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(tables.get("medical_profiles")![0]).toMatchObject({ person_id: "person-1", allergies: "peanuts" });
  });

  it("writes an update Clubspot changed", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [{ id: "person-1", first_name: "Alex" }],
      medical_profiles: [existingProfile({ allergies: "peanuts" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      ...mirrorFieldsFor({ firstName: "Alex", medical_allergies: "peanuts" }),
    });
    const data = { firstName: "Alex", medical_allergies: "peanuts, bee stings" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(1);
    expect(tables.get("medical_profiles")![0]).toMatchObject({ allergies: "peanuts, bee stings" });
  });

  it("writes nothing when Clubspot's values match the stored profile", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [{ id: "person-1", first_name: "Alex" }],
      medical_profiles: [existingProfile({ allergies: "peanuts" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      ...mirrorFieldsFor({ firstName: "Alex", medical_allergies: "peanuts" }),
    });
    const data = { firstName: "Alex", medical_allergies: "peanuts" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsWritten).toBe(0);
    expect(tables.get("medical_profiles")![0]).toMatchObject({ allergies: "peanuts" });
  });

  it("never clears an allergy just because this run's form left it blank", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [{ id: "person-1", first_name: "Alex" }],
      medical_profiles: [existingProfile({ allergies: "peanuts" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = new PersonSync(new DirectusClient(baseUrl, token));

    const priorMirror = participantRow({
      id: "participant-1",
      person_id: "person-1",
      ...mirrorFieldsFor({ firstName: "Alex", medical_allergies: "peanuts" }),
    });
    // No medical_allergies at all this time - the guardian retracted it in Clubspot. Every other
    // field is blank on both sides too, and each counts on its own (`synced-fields.test.ts`
    // covers that per field); this only asserts allergies' own outcome.
    const data = { firstName: "Alex" };
    const resolved = await sync.syncParticipant(
      participant(data),
      options({ existingPersonId: "person-1", priorMirror, mirrorFields: mirrorFieldsFor(data) }),
    );

    expect(resolved.fieldsBlankSkipped).toBeGreaterThanOrEqual(1);
    expect(tables.get("medical_profiles")![0]).toMatchObject({ allergies: "peanuts" });
  });
});

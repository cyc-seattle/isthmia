import { describe, it, expect, vi } from "vitest";
import winston from "winston";
import { PersonRow } from "@cyc-seattle/crm";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  ParticipantRow,
  PromotedFieldRow,
  RegistrationRow,
} from "@cyc-seattle/clubspot";
import {
  needsFallbackTargetValues,
  planPromotedFields,
  planPromotedFieldSync,
  planRegistrationPromotedFieldSync,
} from "../src/promoted-fields.js";

function promotedField(labels: string[], targetField = "school"): PromotedFieldRow {
  return { id: "config-1", target_field: targetField as PromotedFieldRow["target_field"], labels };
}

function definition(id: string, label: string, fieldType = "text"): CustomFieldDefinitionRow {
  return { id, camp_id: "camp-1", label, field_type: fieldType, required: false };
}

function response(
  id: string,
  registrationId: string,
  definitionId: string,
  value: string | null,
): CustomFieldResponseRow {
  return { id, registration_id: registrationId, definition_id: definitionId, value };
}

function registration(id: string, registeredAt: string, overrides: Partial<RegistrationRow> = {}): RegistrationRow {
  return {
    id,
    participant_id: `participant-${id}`,
    last_sync_run_id: null,
    camp_id: "camp-1",
    registered_at: registeredAt,
    status: "confirmed",
    waiver_status: null,
    archived: false,
    ...overrides,
  };
}

/** The `participants` row `registration(id, ...)` links to, resolved to `personId`. */
function linkedParticipant(id: string, personId: string): Pick<ParticipantRow, "id" | "person_id"> {
  return { id: `participant-${id}`, person_id: personId };
}

function person(id: string, school: string | null = null): PersonRow {
  return {
    id,
    first_name: "Jane",
    last_name: "Doe",
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    school,
  };
}

describe("planPromotedFields", () => {
  it("does nothing and logs at info when promoted_fields is empty", () => {
    const info = vi.spyOn(winston, "info").mockImplementation(() => winston);
    try {
      const plan = planPromotedFields([], [definition("def-1", "School")], [], [], [], [person("person-1")]);
      expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
      expect(info).toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("matches a configured label to a definition despite punctuation and spacing differences", () => {
    const plan = planPromotedFields(
      [promotedField(["Race / Ethnicity"], "school")],
      [definition("def-1", "Race/Ethnicity")],
      [response("resp-1", "reg-1", "def-1", "Answer")],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({
      peoplePatches: [{ id: "person-1", patch: { school: "Answer" } }],
      registrationPatches: [],
    });
  });

  it("fills an empty column from the only response", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School")],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({
      peoplePatches: [{ id: "person-1", patch: { school: "Roosevelt High" } }],
      registrationPatches: [],
    });
  });

  it("never overwrites a column that already holds a value", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School")],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1", "Garfield High")],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });

  it("treats a blank response as no value", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School")],
      [response("resp-1", "reg-1", "def-1", null)],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });

  it("treats a whitespace-only response as no value", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School")],
      [response("resp-1", "reg-1", "def-1", "   ")],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });

  it("prefers a non-archived registration's response over an archived one's, regardless of date", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School"), definition("def-2", "School")],
      [
        response("resp-1", "reg-archived", "def-1", "Old School"),
        response("resp-2", "reg-active", "def-2", "New School"),
      ],
      [
        registration("reg-archived", "2026-03-01T00:00:00Z", { archived: true }),
        registration("reg-active", "2026-01-01T00:00:00Z", { archived: false }),
      ],
      [linkedParticipant("reg-archived", "person-1"), linkedParticipant("reg-active", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({
      peoplePatches: [{ id: "person-1", patch: { school: "New School" } }],
      registrationPatches: [],
    });
  });

  it("prefers the most recently registered response among non-archived registrations", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School"), definition("def-2", "School")],
      [
        response("resp-1", "reg-earlier", "def-1", "Earlier School"),
        response("resp-2", "reg-later", "def-2", "Later School"),
      ],
      [registration("reg-earlier", "2026-01-01T00:00:00Z"), registration("reg-later", "2026-06-01T00:00:00Z")],
      [linkedParticipant("reg-earlier", "person-1"), linkedParticipant("reg-later", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({
      peoplePatches: [{ id: "person-1", patch: { school: "Later School" } }],
      registrationPatches: [],
    });
  });

  it("breaks a tied registered_at deterministically by id descending", () => {
    const buildPlan = () =>
      planPromotedFields(
        [promotedField(["School"])],
        [definition("def-1", "School"), definition("def-2", "School")],
        [response("resp-1", "reg-aaa", "def-1", "School A"), response("resp-2", "reg-zzz", "def-2", "School Z")],
        [registration("reg-aaa", "2026-01-01T00:00:00Z"), registration("reg-zzz", "2026-01-01T00:00:00Z")],
        [linkedParticipant("reg-aaa", "person-1"), linkedParticipant("reg-zzz", "person-1")],
        [person("person-1")],
      );
    const first = buildPlan();
    const second = buildPlan();
    expect(first).toEqual({
      peoplePatches: [{ id: "person-1", patch: { school: "School Z" } }],
      registrationPatches: [],
    });
    expect(second).toEqual(first);
  });

  it("skips a config row naming a target outside the promotable allow-list, and warns", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const plan = planPromotedFields(
        [promotedField(["Grade"], "grade")],
        [definition("def-1", "Grade")],
        [response("resp-1", "reg-1", "def-1", "5th")],
        [registration("reg-1", "2026-01-01T00:00:00Z")],
        [linkedParticipant("reg-1", "person-1")],
        [person("person-1")],
      );
      expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("grade"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once for a configured label matching no definition", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const plan = planPromotedFields(
        [promotedField(["School Nickname"])],
        [definition("def-1", "School")],
        [],
        [],
        [],
        [person("person-1")],
      );
      expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("School Nickname"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a response on a registration whose participant has no resolved person, and warns once with the count", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const plan = planPromotedFields(
        [promotedField(["School"])],
        [definition("def-1", "School")],
        [
          response("resp-1", "reg-unlinked", "def-1", "Roosevelt High"),
          response("resp-2", "reg-other-unlinked", "def-1", "Garfield High"),
        ],
        [
          registration("reg-unlinked", "2026-01-01T00:00:00Z"),
          registration("reg-other-unlinked", "2026-01-01T00:00:00Z"),
        ],
        // Neither participant is linked to a person yet.
        [],
        [person("person-1"), person("person-2")],
      );
      expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("2"),
        expect.objectContaining({ skippedForNoPerson: 2 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a matching definition whose field_type isn't a scalar type", () => {
    const plan = planPromotedFields(
      [promotedField(["School"])],
      [definition("def-1", "School", "file_upload")],
      [response("resp-1", "reg-1", "def-1", "some-file.pdf")],
      [registration("reg-1", "2026-01-01T00:00:00Z")],
      [linkedParticipant("reg-1", "person-1")],
      [person("person-1")],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });

  it("fills a registration's own null share_contact from its own stored answer", () => {
    const plan = planPromotedFields(
      [promotedField(["Share contact info?"], "share_contact")],
      [definition("def-1", "Share contact info?")],
      [response("resp-1", "reg-1", "def-1", "Yes")],
      [registration("reg-1", "2026-01-01T00:00:00Z", { share_contact: null })],
      [],
      [],
    );
    expect(plan).toEqual({
      peoplePatches: [],
      registrationPatches: [{ id: "reg-1", patch: { share_contact: true } }],
    });
  });

  it("never overwrites a registration's already-answered share_contact", () => {
    const plan = planPromotedFields(
      [promotedField(["Share contact info?"], "share_contact")],
      [definition("def-1", "Share contact info?")],
      [response("resp-1", "reg-1", "def-1", "Yes")],
      [registration("reg-1", "2026-01-01T00:00:00Z", { share_contact: false })],
      [],
      [],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });

  it("never fills share_contact from an answer that parses as neither Yes nor No", () => {
    const plan = planPromotedFields(
      [promotedField(["Share contact info?"], "share_contact")],
      [definition("def-1", "Share contact info?")],
      [response("resp-1", "reg-1", "def-1", "Maybe")],
      [registration("reg-1", "2026-01-01T00:00:00Z", { share_contact: null })],
      [],
      [],
    );
    expect(plan).toEqual({ peoplePatches: [], registrationPatches: [] });
  });
});

describe("planPromotedFieldSync", () => {
  const targetByDefinitionId = new Map([["def-1", "school" as const]]);

  it("writes nothing when v repeats the stored response - a staff edit holds", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1", response: "Roosevelt High" }],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      { school: "Staff School" },
    );
    expect(plan).toEqual({ patch: {}, written: 0, replacedStaffEdits: 0, blankSkipped: 0, replacedFields: [] });
  });

  it("writes over a stale answer, counting the replaced staff edit", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1", response: "Garfield High" }],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      { school: "Staff School" },
    );
    expect(plan).toEqual({
      patch: { school: "Garfield High" },
      written: 1,
      replacedStaffEdits: 1,
      blankSkipped: 0,
      replacedFields: ["school"],
    });
  });

  it("writes a changed answer without counting a replaced staff edit when nothing had replaced base yet", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1", response: "Garfield High" }],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      { school: "Roosevelt High" },
    );
    expect(plan).toEqual({
      patch: { school: "Garfield High" },
      written: 1,
      replacedStaffEdits: 0,
      blankSkipped: 0,
      replacedFields: [],
    });
  });

  it("never writes a blank response, and counts it instead", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1" }],
      [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      { school: "Staff School" },
    );
    expect(plan).toEqual({ patch: {}, written: 0, replacedStaffEdits: 0, blankSkipped: 1, replacedFields: [] });
  });

  it("fills only a null person column on this response's first sync, leaving an already-set one alone", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1", response: "Roosevelt High" }],
      [], // no stored response yet for this registration+definition
      { school: null },
    );
    expect(plan).toEqual({
      patch: { school: "Roosevelt High" },
      written: 1,
      replacedStaffEdits: 0,
      blankSkipped: 0,
      replacedFields: [],
    });

    const alreadySet = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-1", response: "Roosevelt High" }],
      [],
      { school: "Garfield High" },
    );
    expect(alreadySet).toEqual({ patch: {}, written: 0, replacedStaffEdits: 0, blankSkipped: 0, replacedFields: [] });
  });

  it("ignores a response whose custom field isn't mapped to a promotable target", () => {
    const plan = planPromotedFieldSync(
      targetByDefinitionId,
      [{ customFieldID: "def-unrelated", response: "5th grade" }],
      [],
      { school: null },
    );
    expect(plan).toEqual({ patch: {}, written: 0, replacedStaffEdits: 0, blankSkipped: 0, replacedFields: [] });
  });
});

describe("planRegistrationPromotedFieldSync", () => {
  it("writes a registration's first answer", () => {
    const plan = planRegistrationPromotedFieldSync(
      [{ customFieldID: "def-1", response: "Yes" }],
      [], // no stored response yet for this registration
      null,
    );
    expect(plan).toEqual({
      patch: { share_contact: true },
      written: 1,
      replacedStaffEdits: 0,
      blankSkipped: 0,
      replacedFields: [],
      unknownAnswers: 0,
    });
  });

  it("writes a changed answer, overwriting a portal edit", () => {
    const plan = planRegistrationPromotedFieldSync(
      [{ customFieldID: "def-1", response: "Yes" }],
      [response("resp-1", "reg-1", "def-1", "No")],
      true, // the family toggled it on via the portal, away from the stored "No"
    );
    expect(plan).toEqual({
      patch: { share_contact: true },
      written: 1,
      replacedStaffEdits: 1,
      blankSkipped: 0,
      replacedFields: ["share_contact"],
      unknownAnswers: 0,
    });
  });

  it("leaves a portal edit alone when Clubspot repeats its stored answer", () => {
    const plan = planRegistrationPromotedFieldSync(
      [{ customFieldID: "def-1", response: "Yes" }],
      [response("resp-1", "reg-1", "def-1", "Yes")],
      false, // the family toggled it off via the portal
    );
    expect(plan).toEqual({
      patch: {},
      written: 0,
      replacedStaffEdits: 0,
      blankSkipped: 0,
      replacedFields: [],
      unknownAnswers: 0,
    });
  });

  it("never writes an answer that parses as neither Yes nor No, and counts and logs it", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const plan = planRegistrationPromotedFieldSync([{ customFieldID: "def-1", response: "Maybe" }], [], null);
      expect(plan).toEqual({
        patch: {},
        written: 0,
        replacedStaffEdits: 0,
        blankSkipped: 0,
        replacedFields: [],
        unknownAnswers: 1,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("def-1"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("needsFallbackTargetValues", () => {
  const targetByDefinitionId = new Map([["def-1", "school" as const]]);

  it("is false when every promotable response already has its own stored row", () => {
    expect(
      needsFallbackTargetValues(
        targetByDefinitionId,
        [{ customFieldID: "def-1", response: "Roosevelt High" }],
        [response("resp-1", "reg-1", "def-1", "Roosevelt High")],
      ),
    ).toBe(false);
  });

  it("is true when a promotable response has no stored row yet", () => {
    expect(
      needsFallbackTargetValues(targetByDefinitionId, [{ customFieldID: "def-1", response: "Roosevelt High" }], []),
    ).toBe(true);
  });

  it("is false when the only unstored response isn't mapped to a promotable target", () => {
    expect(
      needsFallbackTargetValues(targetByDefinitionId, [{ customFieldID: "def-unrelated", response: "5th grade" }], []),
    ).toBe(false);
  });
});

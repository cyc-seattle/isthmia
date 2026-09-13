import { describe, it, expect } from "vitest";
import type { Camp, CustomField, Registration, RegistrationCampSession } from "@cyc-seattle/clubspot-sdk";
import {
  buildRegistrationRow,
  calculateEntryStatus,
  CustomFieldResponseRow,
  planCustomFieldDefinitions,
  planCustomFieldResponses,
  planRegistrationBilling,
  planRegistrationEntries,
  planRegistrations,
  REGISTRATION_CREATE_ORDER,
  RegistrationBillingRow,
  RegistrationEntryRow,
  RegistrationRow,
} from "../src/registrations.js";

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor, per roster.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function participant(id: string, data: Record<string, unknown> = {}) {
  return parseObject(id, data);
}

function registration(id: string, data: Record<string, unknown>) {
  return parseObject(id, data) as unknown as Registration;
}

const CONFIRMED_AT = new Date("2026-05-01T12:00:00Z");

function confirmedRegistration(id: string, overrides: Record<string, unknown> = {}) {
  return registration(id, {
    campObject: { id: "camp-1" },
    participantsArray: [participant("participant-1")],
    confirmed_at: CONFIRMED_AT,
    status: "confirmed",
    waiver_status: "fully_signed",
    archived: false,
    ...overrides,
  });
}

describe("buildRegistrationRow", () => {
  it("throws when the registration has no confirmed_at", () => {
    const unconfirmed = registration("reg-1", { campObject: { id: "camp-1" }, status: "applied" });
    expect(() => buildRegistrationRow(unconfirmed, "program-1", "person-1", "participant-1")).toThrow(/confirmed_at/);
  });
});

describe("planRegistrations", () => {
  const programByCamp = new Map([["camp-1", "program-row-1"]]);
  const personByParticipant = new Map([["participant-1", "person-row-1"]]);

  it("creates a new registration", () => {
    const plan = planRegistrations([confirmedRegistration("reg-1")], programByCamp, personByParticipant, []);
    expect(plan.toCreate).toEqual([
      {
        person_id: "person-row-1",
        program_id: "program-row-1",
        clubspot_registration_id: "reg-1",
        registered_at: CONFIRMED_AT.toISOString(),
        status: "confirmed",
        waiver_status: "fully_signed",
        archived: false,
        clubspot_participant_id: "participant-1",
      },
    ]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("produces no write for an unchanged registration", () => {
    const existing: RegistrationRow[] = [
      {
        id: "row-1",
        person_id: "person-row-1",
        program_id: "program-row-1",
        clubspot_registration_id: "reg-1",
        registered_at: CONFIRMED_AT.toISOString(),
        status: "confirmed",
        waiver_status: "fully_signed",
        archived: false,
        clubspot_participant_id: "participant-1",
      },
    ];
    const plan = planRegistrations([confirmedRegistration("reg-1")], programByCamp, personByParticipant, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("updates a mutable field without touching the stored person_id", () => {
    const existing: RegistrationRow[] = [
      {
        id: "row-1",
        person_id: "some-other-person-row",
        program_id: "program-row-1",
        clubspot_registration_id: "reg-1",
        registered_at: CONFIRMED_AT.toISOString(),
        status: "applied",
        waiver_status: "fully_signed",
        archived: false,
        clubspot_participant_id: "participant-1",
      },
    ];
    // personByParticipant would now resolve to "person-row-1", not the stored "some-other-person-row" -
    // that must never overwrite the FK set at creation.
    const plan = planRegistrations([confirmedRegistration("reg-1")], programByCamp, personByParticipant, existing);
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { status: "confirmed" } }]);
  });

  it("skips a registration with no participant instead of crashing", () => {
    const plan = planRegistrations(
      [confirmedRegistration("reg-1", { participantsArray: [] })],
      programByCamp,
      personByParticipant,
      [],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });
});

describe("calculateEntryStatus", () => {
  it("archived wins over waitlist and the registration's status", () => {
    expect(calculateEntryStatus(true, true, "confirmed")).toBe("cancelled");
  });

  it("waitlist wins over the registration's status when not archived", () => {
    expect(calculateEntryStatus(false, true, "confirmed")).toBe("waitlist");
  });

  it("falls back to the registration's own status", () => {
    expect(calculateEntryStatus(false, false, "confirmed")).toBe("confirmed");
  });
});

describe("planRegistrationEntries", () => {
  const classByClubspotId = new Map([["class-1", "class-row-1"]]);
  const sessionByClubspotId = new Map([["session-1", "session-row-1"]]);

  function joinObject(id: string, opts: { waitlist?: boolean } = {}) {
    return parseObject(id, {
      campSessionObject: { id: "session-1" },
      campClassObject: { id: "class-1" },
      waitlist: opts.waitlist ?? false,
    }) as unknown as RegistrationCampSession;
  }

  it("creates an entry for a new join object", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [joinObject("join-1")] });
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, []);
    expect(plan.toCreate).toEqual([
      {
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-1",
      },
    ]);
  });

  it("cancels an entry that vanished from Clubspot's current set, and leaves a present one alone", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [joinObject("join-1")] });
    const existing: RegistrationEntryRow[] = [
      {
        id: "entry-1",
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-1",
      },
      {
        id: "entry-2",
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-2-removed",
      },
    ];
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([{ id: "entry-2", patch: { status: "cancelled" } }]);
  });

  it("does not touch another registration's entries", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [] });
    const existing: RegistrationEntryRow[] = [
      {
        id: "entry-other",
        registration_id: "row-OTHER",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-other",
      },
    ];
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });
});

describe("planRegistrationBilling", () => {
  function billing(id: string, data: Record<string, unknown>) {
    return parseObject(id, data);
  }

  it("maps cents through unchanged, and a missing optional amount becomes 0", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-1", {
        amount: 10000,
        amountPending: 2500,
        amount_received: 7500,
        currency: "usd",
        // amountRefunded, amount_capturable, amount_deferred, deferredAmountBilled, discount,
        // processingFee, processing_passed_on, application_fee_amount, tax all omitted.
      }),
    });
    const plan = planRegistrationBilling(reg, "row-1", []);
    expect(plan.toCreate).toEqual([
      {
        registration_id: "row-1",
        amount: 10000,
        amount_pending: 2500,
        amount_received: 7500,
        amount_refunded: 0,
        amount_capturable: 0,
        amount_deferred: 0,
        deferred_amount_billed: 0,
        discount: 0,
        processing_fee: 0,
        processing_passed_on: 0,
        application_fee_amount: 0,
        tax: 0,
        currency: "usd",
        clubspot_billing_id: "bill-1",
      },
    ]);
  });

  it("produces no row when the registration has no billing object", () => {
    const reg = confirmedRegistration("reg-1");
    const plan = planRegistrationBilling(reg, "row-1", []);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("produces no write for unchanged billing", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-1", { amount: 10000, currency: "usd" }),
    });
    const existing: RegistrationBillingRow[] = [
      {
        id: "billing-row-1",
        registration_id: "row-1",
        amount: 10000,
        amount_pending: 0,
        amount_received: 0,
        amount_refunded: 0,
        amount_capturable: 0,
        amount_deferred: 0,
        deferred_amount_billed: 0,
        discount: 0,
        processing_fee: 0,
        processing_passed_on: 0,
        application_fee_amount: 0,
        tax: 0,
        currency: "usd",
        clubspot_billing_id: "bill-1",
      },
    ];
    const plan = planRegistrationBilling(reg, "row-1", existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });
});

describe("planCustomFieldDefinitions", () => {
  function customField(id: string, data: Record<string, unknown>) {
    return parseObject(id, data) as unknown as CustomField;
  }

  function camp(id: string, fields: ReturnType<typeof customField>[]) {
    return parseObject(id, { customFieldsArray: fields }) as unknown as Camp;
  }

  it("takes label from CustomField.name, not `label`", () => {
    const field = customField("field-1", { name: "School", type: "text", required: false });
    const programByCamp = new Map([["camp-1", "program-row-1"]]);
    const plan = planCustomFieldDefinitions([camp("camp-1", [field])], programByCamp, []);
    expect(plan.toCreate).toEqual([
      {
        program_id: "program-row-1",
        label: "School",
        field_type: "text",
        required: false,
        clubspot_custom_field_id: "field-1",
      },
    ]);
  });
});

describe("planCustomFieldResponses", () => {
  it("resolves a response to its definition", () => {
    const reg = confirmedRegistration("reg-1", {
      participantsArray: [
        participant("participant-1", { customFieldsArray: [{ customFieldID: "field-1", response: "Roosevelt High" }] }),
      ],
    });
    const definitionByClubspotId = new Map([["field-1", "definition-row-1"]]);
    const plan = planCustomFieldResponses(reg, "row-1", definitionByClubspotId, []);
    expect(plan.toCreate).toEqual([
      { registration_id: "row-1", definition_id: "definition-row-1", value: "Roosevelt High" },
    ]);
  });

  it("skips a response whose customFieldID matches no known definition", () => {
    const reg = confirmedRegistration("reg-1", {
      participantsArray: [
        participant("participant-1", {
          customFieldsArray: [{ customFieldID: "field-archived", response: "some answer" }],
        }),
      ],
    });
    const plan = planCustomFieldResponses(reg, "row-1", new Map(), []);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("updates an existing response whose value changed", () => {
    const reg = confirmedRegistration("reg-1", {
      participantsArray: [
        participant("participant-1", { customFieldsArray: [{ customFieldID: "field-1", response: "New answer" }] }),
      ],
    });
    const existing: CustomFieldResponseRow[] = [
      { id: "response-1", registration_id: "row-1", definition_id: "definition-row-1", value: "Old answer" },
    ];
    const definitionByClubspotId = new Map([["field-1", "definition-row-1"]]);
    const plan = planCustomFieldResponses(reg, "row-1", definitionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([{ id: "response-1", patch: { value: "New answer" } }]);
  });
});

describe("REGISTRATION_CREATE_ORDER", () => {
  it("puts registrations before its dependents, and definitions before responses", () => {
    const index = (name: (typeof REGISTRATION_CREATE_ORDER)[number]) => REGISTRATION_CREATE_ORDER.indexOf(name);
    expect(index("registrations")).toBeLessThan(index("registration_entries"));
    expect(index("registrations")).toBeLessThan(index("registration_billing"));
    expect(index("registrations")).toBeLessThan(index("custom_field_responses"));
    expect(index("custom_field_definitions")).toBeLessThan(index("custom_field_responses"));
  });
});

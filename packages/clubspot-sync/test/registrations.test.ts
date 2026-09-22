import { describe, it, expect, vi } from "vitest";
import winston from "winston";
import type { Camp, CustomField, Registration, RegistrationCampSession } from "@cyc-seattle/clubspot-sdk";
import { CustomFieldResponseRow } from "@cyc-seattle/crm";
import {
  buildRegistrationRow,
  calculateEntryStatus,
  planCustomFieldDefinitions,
  planCustomFieldResponses,
  planRegistrationBilling,
  planRegistrationEntries,
  planRegistrations,
  REGISTRATION_CREATE_ORDER,
} from "../src/registrations.js";
import {
  RegistrationBillingWithClubspot,
  RegistrationEntryWithClubspot,
  RegistrationWithClubspot,
} from "../src/schema.js";

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
    expect(() => buildRegistrationRow(unconfirmed, "offering-1", "person-1", "participant-1")).toThrow(/confirmed_at/);
  });

  it("throws when the registration has no status, rather than writing an empty one", () => {
    const noStatus = registration("reg-1", { campObject: { id: "camp-1" }, confirmed_at: CONFIRMED_AT });
    expect(() => buildRegistrationRow(noStatus, "offering-1", "person-1", "participant-1")).toThrow(/status/);
  });
});

describe("planRegistrations", () => {
  const offeringByCamp = new Map([["camp-1", "offering-row-1"]]);
  const personByParticipant = new Map([["participant-1", "person-row-1"]]);

  it("creates a new registration", () => {
    const plan = planRegistrations([confirmedRegistration("reg-1")], offeringByCamp, personByParticipant, []);
    expect(plan.toCreate).toEqual([
      {
        person_id: "person-row-1",
        offering_id: "offering-row-1",
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
    const existing: RegistrationWithClubspot[] = [
      {
        id: "row-1",
        person_id: "person-row-1",
        offering_id: "offering-row-1",
        clubspot_registration_id: "reg-1",
        registered_at: CONFIRMED_AT.toISOString(),
        status: "confirmed",
        waiver_status: "fully_signed",
        archived: false,
        clubspot_participant_id: "participant-1",
      },
    ];
    const plan = planRegistrations([confirmedRegistration("reg-1")], offeringByCamp, personByParticipant, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("updates a mutable field without touching the stored person_id", () => {
    const existing: RegistrationWithClubspot[] = [
      {
        id: "row-1",
        person_id: "some-other-person-row",
        offering_id: "offering-row-1",
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
    const plan = planRegistrations([confirmedRegistration("reg-1")], offeringByCamp, personByParticipant, existing);
    expect(plan.toUpdate).toEqual([{ id: "row-1", patch: { status: "confirmed" } }]);
  });

  it("skips a registration with no participant instead of crashing, and warns and counts it", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      const plan = planRegistrations(
        [confirmedRegistration("reg-1", { participantsArray: [] }), confirmedRegistration("reg-2")],
        offeringByCamp,
        personByParticipant,
        [],
      );
      expect(plan.toCreate).toEqual([
        {
          person_id: "person-row-1",
          offering_id: "offering-row-1",
          clubspot_registration_id: "reg-2",
          registered_at: CONFIRMED_AT.toISOString(),
          status: "confirmed",
          waiver_status: "fully_signed",
          archived: false,
          clubspot_participant_id: "participant-1",
        },
      ]);
      expect(plan.toUpdate).toEqual([]);
      expect(plan.skipped).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reg-1"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("calculateEntryStatus", () => {
  it("archived wins over waitlist and the registration's status", () => {
    expect(calculateEntryStatus(true, true, "confirmed", "reg-1", "join-1")).toBe("cancelled");
  });

  it("waitlist wins over the registration's status when not archived", () => {
    expect(calculateEntryStatus(false, true, "confirmed", "reg-1", "join-1")).toBe("waitlist");
  });

  it("falls back to the registration's own status", () => {
    expect(calculateEntryStatus(false, false, "confirmed", "reg-1", "join-1")).toBe("confirmed");
  });

  it("maps an applied status to confirmed and warns", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
      expect(calculateEntryStatus(false, false, "applied", "reg-1", "join-1")).toBe("confirmed");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("throws on an unrecognized status, naming the status and the row", () => {
    expect(() => calculateEntryStatus(false, false, "some-new-status", "reg-1", "join-1")).toThrow(/some-new-status/);
    expect(() => calculateEntryStatus(false, false, "some-new-status", "reg-1", "join-1")).toThrow(/reg-1/);
    expect(() => calculateEntryStatus(false, false, "some-new-status", "reg-1", "join-1")).toThrow(/join-1/);
  });

  it("throws on an empty status rather than defaulting to confirmed", () => {
    expect(() => calculateEntryStatus(false, false, "", "reg-1", "join-1")).toThrow(/reg-1/);
  });
});

describe("planRegistrationEntries", () => {
  const classByClubspotId = new Map([["class-1", "class-row-1"]]);
  const sessionByClubspotId = new Map([["session-1", "session-row-1"]]);

  function joinObject(id: string, opts: { waitlist?: boolean; data?: Record<string, unknown> } = {}) {
    return parseObject(id, {
      campSessionObject: { id: "session-1" },
      campClassObject: { id: "class-1" },
      waitlist: opts.waitlist ?? false,
      ...opts.data,
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
        clubspot_status: null,
        confirmed_at: null,
        waitlist_number: null,
        accepted_from_waitlist: null,
        priority: null,
      },
    ]);
  });

  it("maps the join object's own fields through, absent ones as null rather than a fabricated default", () => {
    const confirmedAt = new Date("2026-05-02T00:00:00Z");
    const reg = confirmedRegistration("reg-1", {
      sessionJoinObjects: [
        joinObject("join-1", {
          data: {
            status: "confirmed",
            confirmed_at: confirmedAt,
            waitlistNumber: 3,
            acceptedFromWaitlist: true,
            priority: 2,
          },
        }),
      ],
    });
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, []);
    expect(plan.toCreate).toEqual([
      {
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-1",
        clubspot_status: "confirmed",
        confirmed_at: confirmedAt.toISOString(),
        waitlist_number: 3,
        accepted_from_waitlist: true,
        priority: 2,
      },
    ]);
  });

  it("cancels an entry that vanished from Clubspot's current set, and leaves a present one alone", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [joinObject("join-1")] });
    const existing: RegistrationEntryWithClubspot[] = [
      {
        id: "entry-1",
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-1",
        clubspot_status: null,
        confirmed_at: null,
        waitlist_number: null,
        accepted_from_waitlist: null,
        priority: null,
      },
      {
        id: "entry-2",
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-2-removed",
        clubspot_status: null,
        confirmed_at: null,
        waitlist_number: null,
        accepted_from_waitlist: null,
        priority: null,
      },
    ];
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([{ id: "entry-2", patch: { status: "cancelled" } }]);
  });

  it("does not touch another registration's entries", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [] });
    const existing: RegistrationEntryWithClubspot[] = [
      {
        id: "entry-other",
        registration_id: "row-OTHER",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-other",
        clubspot_status: null,
        confirmed_at: null,
        waitlist_number: null,
        accepted_from_waitlist: null,
        priority: null,
      },
    ];
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("drops an entry referencing an unresolvable session and warns, without touching an existing row for it", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    const unresolvable = parseObject("join-missing", {
      campSessionObject: { id: "session-missing" },
      campClassObject: { id: "class-1" },
      waitlist: false,
    }) as unknown as RegistrationCampSession;
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [unresolvable] });
    const existing: RegistrationEntryWithClubspot[] = [
      {
        id: "entry-1",
        registration_id: "row-1",
        session_id: "session-row-1",
        class_id: "class-row-1",
        status: "confirmed",
        clubspot_session_join_id: "join-missing",
        clubspot_status: null,
        confirmed_at: null,
        waitlist_number: null,
        accepted_from_waitlist: null,
        priority: null,
      },
    ];
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.skipped).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("join-missing"), expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session-missing"), expect.anything());
    warn.mockRestore();
  });

  it("still throws when the class hasn't been synced yet", () => {
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [joinObject("join-1")] });
    expect(() => planRegistrationEntries(reg, "row-1", new Map(), sessionByClubspotId, [])).toThrow(/class/);
  });

  it("treats an absent waitlist as false, same as Clubspot omitting archived", () => {
    const noWaitlist = parseObject("join-1", {
      campSessionObject: { id: "session-1" },
      campClassObject: { id: "class-1" },
      // waitlist omitted.
    }) as unknown as RegistrationCampSession;
    const reg = confirmedRegistration("reg-1", { sessionJoinObjects: [noWaitlist] });
    const plan = planRegistrationEntries(reg, "row-1", classByClubspotId, sessionByClubspotId, []);
    expect(plan.toCreate).toEqual([expect.objectContaining({ status: "confirmed" })]);
  });
});

describe("planRegistrationBilling", () => {
  function billing(id: string, data: Record<string, unknown>) {
    return { ...parseObject(id, data), isDataAvailable: () => true };
  }

  it("throws when billing_registration is an unfetched pointer, naming both the registration and billing ids", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: { ...parseObject("bill-1", {}), isDataAvailable: () => false },
    });
    expect(() => planRegistrationBilling(reg, "row-1", [])).toThrow(/unfetched/);
    expect(() => planRegistrationBilling(reg, "row-1", [])).toThrow(/reg-1/);
    expect(() => planRegistrationBilling(reg, "row-1", [])).toThrow(/bill-1/);
  });

  const FULL_BILLING_FIELDS = {
    amount: 10000,
    amountPending: 2500,
    amountRefunded: 500,
    amount_capturable: 0,
    amount_deferred: 0,
    amount_received: 7500,
    application_fee_amount: 100,
    discount: 200,
    processingFee: 300,
    processing_passed_on: 300,
    tax: 400,
  };

  // All-zero variant of the required fields, for tests that only care about `amount`.
  const ZERO_BILLING_FIELDS = Object.fromEntries(Object.keys(FULL_BILLING_FIELDS).map((field) => [field, 0]));

  it("maps cents through unchanged, and a missing deferredAmountBilled becomes 0", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-1", { ...FULL_BILLING_FIELDS, currency: "usd" }),
    });
    const plan = planRegistrationBilling(reg, "row-1", []);
    expect(plan.toCreate).toEqual([
      {
        registration_id: "row-1",
        amount: 10000,
        amount_pending: 2500,
        amount_received: 7500,
        amount_refunded: 500,
        amount_capturable: 0,
        amount_deferred: 0,
        deferred_amount_billed: 0,
        discount: 200,
        processing_fee: 300,
        processing_passed_on: 300,
        application_fee_amount: 100,
        tax: 400,
        currency: "usd",
        clubspot_billing_id: "bill-1",
      },
    ]);
  });

  it("maps an absent amount field to 0, not a throw", () => {
    const data = { ...FULL_BILLING_FIELDS } as Record<string, unknown>;
    delete data.amount;
    const reg = confirmedRegistration("reg-1", { billing_registration: billing("bill-1", data) });
    const plan = planRegistrationBilling(reg, "row-1", []);
    expect(plan.toCreate).toEqual([expect.objectContaining({ amount: 0 })]);
  });

  it("maps currency to null for a fetched billing object with no currency, a legitimate free registration", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-1", {
        amount: 0,
        amountPending: 0,
        amount_received: 0,
        amountRefunded: 0,
        amount_capturable: 0,
        amount_deferred: 0,
        deferredAmountBilled: 0,
        discount: 0,
        processingFee: 0,
        processing_passed_on: 0,
        application_fee_amount: 0,
        tax: 0,
      }),
    });
    const plan = planRegistrationBilling(reg, "row-1", []);
    expect(plan.toCreate).toEqual([
      {
        registration_id: "row-1",
        amount: 0,
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
        currency: null,
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

  it("updates the existing row when Clubspot replaces the billing object, rather than creating a second one", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-2", { ...ZERO_BILLING_FIELDS, amount: 12000, currency: "usd" }),
    });
    const existing: RegistrationBillingWithClubspot[] = [
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
    expect(plan.toUpdate).toEqual([{ id: "billing-row-1", patch: { amount: 12000, clubspot_billing_id: "bill-2" } }]);
  });

  it("produces no write for unchanged billing", () => {
    const reg = confirmedRegistration("reg-1", {
      billing_registration: billing("bill-1", { ...ZERO_BILLING_FIELDS, amount: 10000, currency: "usd" }),
    });
    const existing: RegistrationBillingWithClubspot[] = [
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
    const offeringByCamp = new Map([["camp-1", "offering-row-1"]]);
    const plan = planCustomFieldDefinitions([camp("camp-1", [field])], offeringByCamp, []);
    expect(plan.toCreate).toEqual([
      {
        offering_id: "offering-row-1",
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

  it("skips a response whose customFieldID matches no known definition, and warns and counts it", () => {
    const warn = vi.spyOn(winston, "warn").mockImplementation(() => winston);
    try {
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
      expect(plan.skipped).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reg-1"), expect.anything());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("field-archived"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("writes a null value for an unanswered field, and still plans an answered one normally", () => {
    const reg = confirmedRegistration("reg-1", {
      participantsArray: [
        participant("participant-1", {
          customFieldsArray: [{ customFieldID: "field-1" }, { customFieldID: "field-2", response: "Roosevelt High" }],
        }),
      ],
    });
    const definitionByClubspotId = new Map([
      ["field-1", "definition-row-1"],
      ["field-2", "definition-row-2"],
    ]);
    const plan = planCustomFieldResponses(reg, "row-1", definitionByClubspotId, []);
    expect(plan.toCreate).toEqual([
      { registration_id: "row-1", definition_id: "definition-row-1", value: null },
      { registration_id: "row-1", definition_id: "definition-row-2", value: "Roosevelt High" },
    ]);
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

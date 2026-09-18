import winston from "winston";
import { Camp, CustomField, Participant, Registration, RegistrationCampSession } from "@cyc-seattle/clubspot-sdk";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  RegistrationBillingRow,
  RegistrationEntryRow,
  RegistrationRow,
} from "@cyc-seattle/crm";
import { CollectionPlan, diffFields, planByKey, requireLookup } from "./schedule.js";

/**
 * Pure plan functions for the registration pass: `custom_field_definitions`, `registrations`,
 * `registration_entries`, `registration_billing`, and `custom_field_responses`. Same shape as
 * `schedule.ts` - a thin executor elsewhere reads existing rows and writes the plan.
 *
 * Creates must happen in this order: `custom_field_definitions` and `registrations` have no FK on
 * each other, but everything else carries a FK to `registrations`, and `custom_field_responses`
 * also carries one to `custom_field_definitions`.
 */
export const REGISTRATION_CREATE_ORDER = [
  "custom_field_definitions",
  "registrations",
  "registration_entries",
  "registration_billing",
  "custom_field_responses",
] as const;

/**
 * Clubspot's `participantsArray` is still an array, but only ever holds one element today - a
 * registration now has exactly one participant. Reach through it here rather than at every call
 * site, so an empty array is a normal `undefined`, not a crash.
 */
export function firstParticipant(registration: Registration): Participant | undefined {
  return registration.get("participantsArray")?.[0];
}

// registration_entries.status is a three-choice enum (docs/crm-schema.md), but Registration.status
// carries Clubspot's own vocabulary. queryCampEntries filters on confirmed_at, not status, so
// "applied" or "invited" - or no status at all - can reach here on a registration that already has
// a confirmed_at. All fold to "confirmed": that's what confirmed_at plus no archive/waitlist means.
const KNOWN_REGISTRATION_STATUSES = new Set(["confirmed", "applied", "invited"]);

/** Archived wins, then waitlist, then the registration's own status. Same rule as `participants.ts`'s calculateStatus. */
export function calculateEntryStatus(archived: boolean, waitlist: boolean, registrationStatus: string): string {
  if (archived) {
    return "cancelled";
  }
  if (waitlist) {
    return "waitlist";
  }
  if (!KNOWN_REGISTRATION_STATUSES.has(registrationStatus)) {
    winston.warn(
      `Unrecognized registration status "${registrationStatus}"; defaulting registration_entries.status to "confirmed"`,
      { registrationStatus },
    );
    return "confirmed";
  }
  if (registrationStatus !== "confirmed") {
    winston.warn(`Registration status "${registrationStatus}" has a confirmed_at; treating its entries as confirmed`, {
      registrationStatus,
    });
  }
  return "confirmed";
}

/**
 * `registered_at` is NOT NULL, and `queryCampEntries` already filters registrations to those with
 * a `confirmed_at`. Throwing here catches a caller that skipped that filter, rather than writing a
 * fabricated date.
 */
export function buildRegistrationRow(
  registration: Registration,
  programCrmId: string,
  personId: string,
  clubspotParticipantId: string,
): Omit<RegistrationRow, "id"> {
  const confirmedAt = registration.get("confirmed_at");
  if (!confirmedAt) {
    throw new Error(`Registration ${registration.id} has no confirmed_at; registered_at is not nullable`);
  }
  return {
    person_id: personId,
    program_id: programCrmId,
    clubspot_registration_id: registration.id,
    registered_at: confirmedAt.toISOString(),
    status: registration.get("status") ?? "",
    waiver_status: registration.get("waiver_status") ?? null,
    archived: registration.get("archived") ?? false,
    clubspot_participant_id: clubspotParticipantId,
  };
}

/**
 * Reconciles `registrations` by `clubspot_registration_id`. `person_id` and
 * `clubspot_participant_id` are resolved once, at creation, and never revisited, so an existing
 * row's update patch is pinned to its own stored values for those two fields, even if
 * `personIdByClubspotParticipantId` would now resolve differently.
 */
export function planRegistrations(
  registrations: Registration[],
  programCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  personIdByClubspotParticipantId: ReadonlyMap<string, string>,
  existing: RegistrationRow[],
): CollectionPlan<RegistrationRow> {
  const existingByClubspotId = new Map<string, RegistrationRow>();
  for (const row of existing) {
    existingByClubspotId.set(row.clubspot_registration_id, row);
  }

  const toCreate: Omit<RegistrationRow, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<RegistrationRow> }[] = [];
  let skipped = 0;

  for (const registration of registrations) {
    const participant = firstParticipant(registration);
    if (!participant) {
      // No participant means no person to point person_id at. registrations.person_id is NOT
      // NULL, so this registration isn't ready to sync yet - not a bug to crash on.
      winston.warn(`Registration ${registration.id} has no participant; skipping`, {
        clubspotRegistrationId: registration.id,
      });
      skipped++;
      continue;
    }

    const campId = registration.get("campObject")?.id;
    if (!campId) {
      throw new Error(`Registration ${registration.id} has no campObject; only camp registrations are synced here`);
    }
    const personId = personIdByClubspotParticipantId.get(participant.id);
    if (!personId) {
      throw new Error(`No resolved person for participant ${participant.id}; sync people before registrations`);
    }

    const row = buildRegistrationRow(
      registration,
      requireLookup(programCrmIdByClubspotCampId, campId, "program"),
      personId,
      participant.id,
    );

    const match = existingByClubspotId.get(registration.id);
    if (!match?.id) {
      toCreate.push(row);
      continue;
    }

    const patch = diffFields(match, {
      ...row,
      person_id: match.person_id,
      clubspot_participant_id: match.clubspot_participant_id,
    });
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: match.id, patch });
    }
  }

  return { toCreate, toUpdate, skipped };
}

/**
 * Reconciles one registration's `registration_entries` against its current
 * `sessionJoinObjects`. When Clubspot drops a session from a registration, the join object simply
 * disappears - there's no id to detect the removal by - so any existing entry whose
 * `clubspot_session_join_id` is no longer present is cancelled here, never deleted.
 */
export function planRegistrationEntries(
  registration: Registration,
  registrationCrmId: string,
  classCrmIdByClubspotClassId: ReadonlyMap<string, string>,
  sessionCrmIdByClubspotSessionId: ReadonlyMap<string, string>,
  existing: RegistrationEntryRow[],
): CollectionPlan<RegistrationEntryRow> {
  const archived = registration.get("archived") ?? false;
  const registrationStatus = registration.get("status") ?? "";
  const joinObjects = registration.get("sessionJoinObjects") ?? [];

  let skipped = 0;
  const desired = joinObjects.flatMap((joinObject: RegistrationCampSession) => {
    const clubspotSessionId = joinObject.get("campSessionObject").id;
    const sessionId = sessionCrmIdByClubspotSessionId.get(clubspotSessionId);
    if (!sessionId) {
      // Dropping the entry is real data loss - the session may be archived or genuinely deleted,
      // and telling those apart needs a live Clubspot query this sync doesn't make - so the
      // warning names every id needed to find the row later.
      winston.warn(
        `Registration ${registration.id} join ${joinObject.id} references unresolved Clubspot session ${clubspotSessionId}; skipping entry`,
        {
          clubspotRegistrationId: registration.id,
          clubspotSessionJoinId: joinObject.id,
          clubspotSessionId,
        },
      );
      skipped++;
      return [];
    }
    return [
      {
        key: joinObject.id,
        row: {
          registration_id: registrationCrmId,
          session_id: sessionId,
          class_id: requireLookup(classCrmIdByClubspotClassId, joinObject.get("campClassObject").id, "class"),
          status: calculateEntryStatus(archived, joinObject.get("waitlist") ?? false, registrationStatus),
          clubspot_session_join_id: joinObject.id,
        },
      },
    ];
  });

  // Scoped to this registration's own rows, so a vanished entry never cancels another
  // registration's entry that happens to share a class or session.
  const existingForRegistration = existing.filter((row) => row.registration_id === registrationCrmId);
  const plan = planByKey(desired, existingForRegistration, "clubspot_session_join_id");

  // Built from every join object, including ones skipped above for an unresolved session -
  // otherwise a skipped join object's existing row would get cancelled rather than left alone.
  const desiredKeys = new Set(joinObjects.map((joinObject: RegistrationCampSession) => joinObject.id));
  for (const row of existingForRegistration) {
    if (row.id && row.status !== "cancelled" && !desiredKeys.has(row.clubspot_session_join_id)) {
      plan.toUpdate.push({ id: row.id, patch: { status: "cancelled" } });
    }
  }

  return { ...plan, skipped };
}

function centsOrZero(value: number | undefined): number {
  return value ?? 0;
}

/**
 * Amounts are integer cents, stored exactly as Clubspot holds them, so no float rounding can creep
 * in. Converting to dollars is a display concern, left to whatever renders the row.
 */
export function buildRegistrationBillingRow(
  registration: Registration,
  registrationCrmId: string,
): Omit<RegistrationBillingRow, "id"> | undefined {
  const billing = registration.get("billing_registration");
  if (!billing) {
    return undefined;
  }
  if (!billing.isDataAvailable()) {
    // A present-but-unfetched pointer means queryCampEntries stopped including
    // billing_registration; every get() below would return undefined and zero out real money.
    throw new Error(`Registration ${registration.id} has an unfetched billing_registration pointer ${billing.id}`);
  }
  return {
    registration_id: registrationCrmId,
    amount: centsOrZero(billing.get("amount")),
    amount_pending: centsOrZero(billing.get("amountPending")),
    amount_received: centsOrZero(billing.get("amount_received")),
    amount_refunded: centsOrZero(billing.get("amountRefunded")),
    amount_capturable: centsOrZero(billing.get("amount_capturable")),
    amount_deferred: centsOrZero(billing.get("amount_deferred")),
    deferred_amount_billed: centsOrZero(billing.get("deferredAmountBilled")),
    discount: centsOrZero(billing.get("discount")),
    processing_fee: centsOrZero(billing.get("processingFee")),
    processing_passed_on: centsOrZero(billing.get("processing_passed_on")),
    application_fee_amount: centsOrZero(billing.get("application_fee_amount")),
    tax: centsOrZero(billing.get("tax")),
    currency: billing.get("currency") ?? null,
    clubspot_billing_id: billing.id,
  };
}

/**
 * A registration with no `billing_registration` produces no row - not a zeroed-out one.
 *
 * Reconciled by `registration_id`, not `clubspot_billing_id`: `registration_billing.registration_id`
 * is unique (one billing row per registration), so that's the actual match key. If Clubspot ever
 * replaces a registration's billing object, `clubspot_billing_id` changes but the row doesn't - it's
 * a tracked field on the existing row, not the key that finds it.
 */
export function planRegistrationBilling(
  registration: Registration,
  registrationCrmId: string,
  existing: RegistrationBillingRow[],
): CollectionPlan<RegistrationBillingRow> {
  const row = buildRegistrationBillingRow(registration, registrationCrmId);
  if (!row) {
    return { toCreate: [], toUpdate: [] };
  }

  const existingForRegistration = existing.filter((existingRow) => existingRow.registration_id === registrationCrmId);
  return planByKey([{ key: row.registration_id, row }], existingForRegistration, "registration_id");
}

/**
 * Reconciles `custom_field_definitions` from each camp's `customFieldsArray`. A definition is per
 * camp, not per club: Clubspot gives a cloned field (e.g. "School") a new `objectId` on each camp,
 * and even its label can drift between clones, so one row per camp is expected, and grouping the
 * same logical question across camps is left to reporting.
 */
export function planCustomFieldDefinitions(
  camps: Camp[],
  programCrmIdByClubspotCampId: ReadonlyMap<string, string>,
  existing: CustomFieldDefinitionRow[],
): CollectionPlan<CustomFieldDefinitionRow> {
  const desired = camps.flatMap((camp) =>
    (camp.get("customFieldsArray") ?? []).map((field: CustomField) => ({
      key: field.id,
      row: {
        program_id: requireLookup(programCrmIdByClubspotCampId, camp.id, "program"),
        label: field.get("name"),
        field_type: field.get("type"),
        required: field.get("required") ?? false,
        clubspot_custom_field_id: field.id,
      },
    })),
  );
  return planByKey(desired, existing, "clubspot_custom_field_id");
}

// The SDK doesn't export this shape - Participant.customFieldsArray's element type isn't a
// registered Parse class, just a plain response object - so it's declared locally as the minimum
// shape this mapping reads.
interface CustomFieldResponseInput {
  customFieldID: string;
  response: string;
}

/**
 * Reconciles `custom_field_responses` from the registration's participant. A response whose
 * `customFieldID` matches no known definition is skipped - the definition may be archived, or
 * belong to a camp other than this registration's.
 */
export function planCustomFieldResponses(
  registration: Registration,
  registrationCrmId: string,
  definitionCrmIdByClubspotCustomFieldId: ReadonlyMap<string, string>,
  existing: CustomFieldResponseRow[],
): CollectionPlan<CustomFieldResponseRow> {
  const participant = firstParticipant(registration);
  const responses: readonly CustomFieldResponseInput[] = participant?.get("customFieldsArray") ?? [];

  const toCreate: Omit<CustomFieldResponseRow, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<CustomFieldResponseRow> }[] = [];
  const existingForRegistration = existing.filter((row) => row.registration_id === registrationCrmId);

  for (const response of responses) {
    const definitionId = definitionCrmIdByClubspotCustomFieldId.get(response.customFieldID);
    if (!definitionId) {
      continue;
    }
    const match = existingForRegistration.find((row) => row.definition_id === definitionId);
    if (!match?.id) {
      toCreate.push({ registration_id: registrationCrmId, definition_id: definitionId, value: response.response });
      continue;
    }
    if (match.value !== response.response) {
      toUpdate.push({ id: match.id, patch: { value: response.response } });
    }
  }

  return { toCreate, toUpdate };
}

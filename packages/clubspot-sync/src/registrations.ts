import winston from "winston";
import { Camp, CustomField, Participant, Registration, RegistrationCampSession } from "@cyc-seattle/clubspot-sdk";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  RegistrationBillingRow,
  RegistrationRow,
} from "@cyc-seattle/clubspot";
import { CollectionPlan, diffFields, joinedId, planById } from "./schedule.js";
import { RegistrationEntryWithClubspot } from "./schema.js";

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
// "applied" or "invited" can reach here on a registration that already has a confirmed_at. Both
// fold to "confirmed": that's what confirmed_at plus no archive/waitlist means.
const KNOWN_REGISTRATION_STATUSES = new Set(["confirmed", "applied", "invited"]);

/**
 * Archived wins, then waitlist, then the registration's own status. Same rule as
 * `participants.ts`'s calculateStatus.
 *
 * `registrationId` and `sessionJoinId` are caller-supplied only to name the offending row in the
 * thrown error; `calculateEntryStatus` itself never looks at either object.
 */
export function calculateEntryStatus(
  archived: boolean,
  waitlist: boolean,
  registrationStatus: string,
  registrationId: string,
  sessionJoinId: string,
): string {
  if (archived) {
    return "cancelled";
  }
  if (waitlist) {
    return "waitlist";
  }
  if (!KNOWN_REGISTRATION_STATUSES.has(registrationStatus)) {
    throw new Error(
      `Registration ${registrationId} join ${sessionJoinId} has unrecognized status "${registrationStatus}"; refusing to default registration_entries.status`,
    );
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
  campCrmId: string,
  personId: string,
  participantId: string,
): RegistrationRow {
  const confirmedAt = registration.get("confirmed_at");
  if (!confirmedAt) {
    throw new Error(`Registration ${registration.id} has no confirmed_at; registered_at is not nullable`);
  }
  const status = registration.get("status");
  if (!status) {
    throw new Error(`Registration ${registration.id} has no status; registrations.status is not nullable`);
  }
  return {
    id: registration.id,
    person_id: personId,
    participant_id: participantId,
    last_sync_run_id: null,
    camp_id: campCrmId,
    registered_at: confirmedAt.toISOString(),
    status,
    waiver_status: registration.get("waiver_status") ?? null,
    archived: registration.get("archived") ?? false,
  };
}

/**
 * Reconciles `registrations` by id. `person_id` and `participant_id` are resolved once, at
 * creation, and never revisited, so an existing row's update patch is pinned to its own stored
 * values for both, even if `personIdByClubspotParticipantId` would now resolve differently.
 * `participant_id` is always the registration's own participant id - `participants` is keyed on
 * that same Clubspot objectId, so no lookup is needed to point at it.
 */
export function planRegistrations(
  registrations: Registration[],
  personIdByClubspotParticipantId: ReadonlyMap<string, string>,
  existing: RegistrationRow[],
): CollectionPlan<RegistrationRow> {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));

  const toCreate: RegistrationRow[] = [];
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

    const row = buildRegistrationRow(registration, campId, personId, participant.id);

    const match = existingById.get(registration.id);
    if (!match) {
      toCreate.push(row);
      continue;
    }

    const patch = diffFields(match, { ...row, person_id: match.person_id, participant_id: match.participant_id });
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: registration.id, patch });
    }
  }

  return { toCreate, toUpdate, skipped };
}

/**
 * Reconciles one registration's `registration_entries` against its current
 * `sessionJoinObjects`. When Clubspot drops a session from a registration, the join object simply
 * disappears - there's no id to detect the removal by - so any existing entry whose `id` is no
 * longer present among `joinObjects` is cancelled here, never deleted.
 *
 * `class_id` is written as-is, trusting Postgres - but `session_id` is checked against
 * `knownSessionIds` first, same reasoning as `planEntryCaps`.
 */
export function planRegistrationEntries(
  registration: Registration,
  registrationCrmId: string,
  knownSessionIds: ReadonlySet<string>,
  existing: RegistrationEntryWithClubspot[],
): CollectionPlan<RegistrationEntryWithClubspot> {
  const archived = registration.get("archived") ?? false;
  const registrationStatus = registration.get("status") ?? "";
  const joinObjects = registration.get("sessionJoinObjects") ?? [];

  let skipped = 0;
  const desired = joinObjects.flatMap((joinObject: RegistrationCampSession) => {
    const sessionId = joinObject.get("campSessionObject").id;
    if (!knownSessionIds.has(sessionId)) {
      // Dropping the entry is real data loss - the session may be archived or genuinely deleted,
      // and telling those apart needs a live Clubspot query this sync doesn't make - so the
      // warning names every id needed to find the row later.
      winston.warn(
        `Registration ${registration.id} join ${joinObject.id} references unresolved Clubspot session ${sessionId}; skipping entry`,
        { clubspotRegistrationId: registration.id, clubspotSessionJoinId: joinObject.id, clubspotSessionId: sessionId },
      );
      skipped++;
      return [];
    }
    // Clubspot omits waitlist rather than sending false, same as archived - see buildRegistrationRow.
    const waitlist = joinObject.get("waitlist") ?? false;
    return [
      {
        id: joinObject.id,
        registration_id: registrationCrmId,
        session_id: sessionId,
        class_id: joinObject.get("campClassObject").id,
        status: calculateEntryStatus(archived, waitlist, registrationStatus, registration.id, joinObject.id),
        clubspot_status: joinObject.get("status") ?? null,
        confirmed_at: joinObject.get("confirmed_at")?.toISOString() ?? null,
        waitlist_number: joinObject.get("waitlistNumber") ?? null,
        accepted_from_waitlist: joinObject.get("acceptedFromWaitlist") ?? null,
        priority: joinObject.get("priority") ?? null,
      },
    ];
  });

  // Scoped to this registration's own rows, so a vanished entry never cancels another
  // registration's entry that happens to share a class or session.
  const existingForRegistration = existing.filter((row) => row.registration_id === registrationCrmId);
  const plan = planById(desired, existingForRegistration);

  // Built from every join object, including ones skipped above for an unresolved session -
  // otherwise a skipped join object's existing row would get cancelled rather than left alone.
  const desiredIds = new Set(joinObjects.map((joinObject: RegistrationCampSession) => joinObject.id));
  for (const row of existingForRegistration) {
    if (row.status !== "cancelled" && !desiredIds.has(row.id)) {
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
): RegistrationBillingRow | undefined {
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
    id: billing.id,
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
  };
}

export interface RegistrationBillingPlan {
  toCreate: RegistrationBillingRow[];
  toUpdate: { id: string; patch: Partial<RegistrationBillingRow> }[];
  /** A stale row to delete before `toCreate` can be written - see below. */
  toDelete: string[];
}

/**
 * A registration with no `billing_registration` produces no row - not a zeroed-out one.
 *
 * Reconciled by `registration_id`, not `id`: `registration_billing.registration_id` is unique
 * (one billing row per registration), so that's the actual match key. If Clubspot replaces a
 * registration's billing object, its id changes, so the old row is deleted before the new one is
 * created - an update can't repoint a primary key.
 */
export function planRegistrationBilling(
  registration: Registration,
  registrationCrmId: string,
  existing: RegistrationBillingRow[],
): RegistrationBillingPlan {
  const row = buildRegistrationBillingRow(registration, registrationCrmId);
  const match = existing.find((existingRow) => existingRow.registration_id === registrationCrmId);

  if (!row) {
    return { toCreate: [], toUpdate: [], toDelete: [] };
  }
  if (!match) {
    return { toCreate: [row], toUpdate: [], toDelete: [] };
  }
  if (match.id !== row.id) {
    return { toCreate: [row], toUpdate: [], toDelete: [match.id] };
  }
  const patch = diffFields(match, row);
  return { toCreate: [], toUpdate: Object.keys(patch).length > 0 ? [{ id: row.id, patch }] : [], toDelete: [] };
}

/**
 * Reconciles `custom_field_definitions` from each camp's `customFieldsArray`. A definition is per
 * camp, not per club: Clubspot gives a cloned field (e.g. "School") a new `objectId` on each camp,
 * and even its label can drift between clones, so one row per camp is expected, and grouping the
 * same logical question across camps is left to reporting.
 */
export function planCustomFieldDefinitions(
  camps: Camp[],
  existing: CustomFieldDefinitionRow[],
): CollectionPlan<CustomFieldDefinitionRow> {
  const desired = camps.flatMap((camp) =>
    (camp.get("customFieldsArray") ?? []).map((field: CustomField) => ({
      id: field.id,
      camp_id: camp.id,
      label: field.get("name"),
      field_type: field.get("type"),
      required: field.get("required") ?? false,
    })),
  );
  return planById(desired, existing);
}

// The SDK doesn't export this shape - Participant.customFieldsArray's element type isn't a
// registered Parse class, just a plain response object - so it's declared locally as the minimum
// shape this mapping reads.
interface CustomFieldResponseInput {
  customFieldID: string;
  response?: string;
}

/**
 * Reconciles `custom_field_responses` from the registration's participant, keyed on the join of
 * `registration_id` and `definition_id`. A response whose `customFieldID` matches no known
 * definition is skipped - the definition may be archived, or belong to a camp other than this
 * registration's.
 */
export function planCustomFieldResponses(
  registration: Registration,
  registrationCrmId: string,
  knownDefinitionIds: ReadonlySet<string>,
  existing: CustomFieldResponseRow[],
): CollectionPlan<CustomFieldResponseRow> {
  const participant = firstParticipant(registration);
  const responses: readonly CustomFieldResponseInput[] = participant?.get("customFieldsArray") ?? [];

  let skipped = 0;
  const desired = responses.flatMap((response) => {
    if (!knownDefinitionIds.has(response.customFieldID)) {
      winston.warn(
        `Registration ${registration.id} has a response for unknown Clubspot custom field ${response.customFieldID}; skipping`,
        { clubspotRegistrationId: registration.id, clubspotCustomFieldId: response.customFieldID },
      );
      skipped++;
      return [];
    }
    // An absent response means the participant left this question blank - the normal case for an
    // optional field, not an error.
    const value = response.response ?? null;
    return [
      {
        id: joinedId(registrationCrmId, response.customFieldID),
        registration_id: registrationCrmId,
        definition_id: response.customFieldID,
        value,
      },
    ];
  });

  const existingForRegistration = existing.filter((row) => row.registration_id === registrationCrmId);
  return { ...planById(desired, existingForRegistration), skipped };
}

import { randomUUID } from "node:crypto";
import winston from "winston";
import { Participant } from "@cyc-seattle/clubspot-sdk";
import { ContactPointWithParticipant, ParticipantRow } from "@cyc-seattle/clubspot";
import { ContactRow, MedicalProfileRow, PersonRow } from "@cyc-seattle/crm";
import { DirectusClient } from "@cyc-seattle/directus";
import { ContactPointSlot, contactPointCandidatesFromSlots, upsertContactPoints } from "./contact-points.js";
import {
  buildEmergencyContactRow,
  buildGuardianContactRow,
  buildPersonFieldsFromParticipant,
  ContactMirrorSlot,
  contactFieldValuesFromMirror,
  emergencyContactInputsFromParticipant,
  guardianInputsFromParticipant,
  matchEmergencyContact,
  matchGuardian,
  matchParticipant,
  medicalFieldValuesFromMirror,
  normalizeEmail,
  ParticipantMirrorFields,
  personFieldsFromEmergencyContact,
  personFieldsFromGuardian,
  personFieldValuesFromMirror,
  PersonMatchCandidate,
  slotNameMatchesContact,
  splitContactName,
} from "./people.js";
import {
  addFieldTally,
  bestRanked,
  emptyFieldTally,
  FieldTally,
  isNewestParticipant,
  planSyncedFields,
  Ranked,
  RegistrationRank,
  resolveFieldBase,
} from "./synced-fields.js";

// Directus has no trigram operator over REST, so the fallback candidate fetch is a bounded
// last-name substring search rather than every row in `people`.
const CANDIDATE_LIMIT = 50;

const PERSON_SYNCED_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "date_of_birth",
  "gender",
  "street",
  "city",
  "state",
  "postal_code",
] as const;

const CONTACT_SYNCED_FIELDS = ["first_name", "last_name", "email", "phone"] as const;

const MEDICAL_SYNCED_FIELDS = [
  "conditions",
  "allergies",
  "medications",
  "last_tetanus",
  "physician_name",
  "physician_phone",
  "weight",
] as const;

export interface ResolvedPerson {
  id: string;
  created: boolean;
}

/** A resolved person, plus the CRM row it currently holds - `undefined` only when it was just created. */
interface ResolvedPersonWithCurrent extends ResolvedPerson {
  current?: PersonRow;
}

export interface ParticipantSyncResult extends ResolvedPerson {
  contactPointsCreated: number;
  contactPointsTouched: number;
  fieldsWritten: number;
  fieldsReplacedStaffEdits: number;
  fieldsBlankSkipped: number;
  /** A guardian or emergency-contact slot whose name no longer matched its linked person - skipped, not applied. */
  slotNameMismatches: number;
  /** Whether this registration currently outranks every other one linked to the same person - see `synced-fields.ts`. `sync-run.ts` reuses it to gate the promoted-fields sync. */
  isNewestParticipant: boolean;
  /** The registration this run drew a fallback base from - see `SyncParticipantOptions.batchSiblings`. `sync-run.ts`'s promoted-fields sync reuses it to find the matching fallback response. */
  fallbackRegistrationId?: string;
}

/**
 * Another registration linked to the same person, resolved earlier in this same run - not yet
 * reflected in Directus, since `participants` rows are only written after the whole batch resolves
 * (see `sync-run.ts`'s two-pass `syncRegistrations`). Without these, two registrations for one
 * person newly linked in the same run would each see zero siblings in Directus and both count as
 * the newest.
 */
export interface BatchSibling {
  registration: RegistrationRank;
  participantId: string;
  mirrorFields: ParticipantMirrorFields;
}

export interface SyncParticipantOptions {
  /** The `person_id` already on this participant's `participants` row, if it has one. */
  existingPersonId?: string;
  /** The mirror's stored row before this run's write - `undefined` for a participant mirrored for the first time. */
  priorMirror?: ParticipantRow;
  /** This run's fresh mirror fields for the participant - the `v` side of the one CRM field rule (#137). */
  mirrorFields: ParticipantMirrorFields;
  /** This participant's own registration, ranked against every other registration linked to the same person. */
  registration: RegistrationRank;
  /** Every other registration in this run's batch already resolved to the same person - see {@link BatchSibling}. */
  batchSiblings?: readonly BatchSibling[];
}

/** Logs a replaced staff edit - person id and field names only, never the values (#137). Shared with `sync-run.ts`'s per-registration promoted-fields sync. */
export function logReplacedFields(collection: string, personId: string, fields: readonly string[]): void {
  if (fields.length === 0) {
    return;
  }
  winston.warn(`Clubspot's newest answer replaced a staff-edited value on ${collection}`, { personId, fields });
}

/**
 * Resolves and writes `people`, `contacts`, and `medical_profiles` for one Clubspot
 * `Participant`: the minor, their guardians, and their emergency contacts.
 *
 * Matching only ever runs when a row is about to be created. `syncGuardianContacts` and
 * `syncEmergencyContacts` check for an existing `contacts` row first and, if one exists, leave
 * its `contact_id` exactly as it is: that's what makes a manual merge durable, since staff repoint
 * the FK once and no later sync undoes it.
 *
 * Every curated field on `people`, `medical_profiles`, and a guardian/emergency slot follows the
 * one CRM field rule (#137, `synced-fields.ts`): the newest linked participant's form answer wins,
 * and a staff edit holds until Clubspot sends something new. A participant that isn't currently
 * the newest one linked to its person writes only the `participants` mirror, never `people` or
 * `medical_profiles` - see `isNewestParticipant`.
 */
export class PersonSync {
  constructor(private readonly directus: DirectusClient) {}

  /**
   * Matches or reuses this participant's person, without touching any curated field - the first
   * half of {@link syncParticipant}, split out so `sync-run.ts` can resolve every registration in
   * a batch before ranking any of them (see `BatchSibling`).
   */
  async resolveParticipant(
    participant: Participant,
    options: { existingPersonId?: string } = {},
  ): Promise<ResolvedPerson> {
    const { existingPersonId } = options;
    const fields = buildPersonFieldsFromParticipant(participant);
    const resolved = existingPersonId
      ? await this.reusePerson(existingPersonId)
      : await this.resolvePerson(
          fields,
          (candidates) =>
            matchParticipant(candidates, {
              firstName: fields.first_name,
              lastName: fields.last_name,
              dateOfBirth: fields.date_of_birth,
              email: fields.email,
            }),
          // matchParticipant matches on name + DOB and never falls back to email once a DOB is
          // known, so the same child registered under a different parent's email must still be
          // fetchable: a birthday and a last name identify them, an email address doesn't.
          fields.date_of_birth
            ? () => this.fetchCandidatesByDobAndLastName(fields.date_of_birth as string, fields.last_name)
            : undefined,
        );
    return { id: resolved.id, created: resolved.created };
  }

  async syncParticipant(participant: Participant, options: SyncParticipantOptions): Promise<ParticipantSyncResult> {
    const { existingPersonId, priorMirror, mirrorFields, registration, batchSiblings = [] } = options;
    const fields = buildPersonFieldsFromParticipant(participant);
    const resolved = existingPersonId
      ? await this.reusePerson(existingPersonId)
      : await this.resolvePerson(
          fields,
          (candidates) =>
            matchParticipant(candidates, {
              firstName: fields.first_name,
              lastName: fields.last_name,
              dateOfBirth: fields.date_of_birth,
              email: fields.email,
            }),
          // matchParticipant matches on name + DOB and never falls back to email once a DOB is
          // known, so the same child registered under a different parent's email must still be
          // fetchable: a birthday and a last name identify them, an email address doesn't.
          fields.date_of_birth
            ? () => this.fetchCandidatesByDobAndLastName(fields.date_of_birth as string, fields.last_name)
            : undefined,
        );

    const ranking = resolved.created
      ? { isNewest: true }
      : await this.rankAgainstSiblings(resolved.id, registration, batchSiblings);
    const { isNewest, fallbackMirror, fallbackRegistrationId } = ranking;

    const personFields =
      resolved.created || !isNewest
        ? emptyFieldTally()
        : await this.applySyncedPersonFields(resolved.id, resolved.current, priorMirror, mirrorFields, fallbackMirror);

    const medicalFields = await this.syncMedicalProfile(
      resolved.id,
      priorMirror,
      mirrorFields,
      isNewest,
      fallbackMirror,
    );
    const guardianResult = await this.syncGuardianContacts(
      participant,
      resolved.id,
      priorMirror,
      mirrorFields,
      isNewest,
      fallbackMirror,
    );
    const emergencyResult = await this.syncEmergencyContacts(
      participant,
      resolved.id,
      priorMirror,
      mirrorFields,
      isNewest,
      fallbackMirror,
    );

    const slots: ContactPointSlot[] = [
      { personId: resolved.id, email: fields.email, phone: fields.phone },
      ...guardianResult.slots,
      ...emergencyResult.slots,
    ];
    const candidates = contactPointCandidatesFromSlots(slots).map((candidate) => ({
      ...candidate,
      participantId: participant.id,
    }));
    const contactPoints = await upsertContactPoints(this.directus, candidates, new Date());

    const fieldTally = [personFields, medicalFields, guardianResult.fields, emergencyResult.fields].reduce(
      addFieldTally,
      emptyFieldTally(),
    );

    return {
      ...resolved,
      contactPointsCreated: contactPoints.created,
      contactPointsTouched: contactPoints.touched,
      fieldsWritten: fieldTally.written,
      fieldsReplacedStaffEdits: fieldTally.replacedStaffEdits,
      fieldsBlankSkipped: fieldTally.blankSkipped,
      slotNameMismatches: guardianResult.slotNameMismatches + emergencyResult.slotNameMismatches,
      isNewestParticipant: isNewest,
      ...(fallbackRegistrationId ? { fallbackRegistrationId } : {}),
    };
  }

  /**
   * Ranks `registration` against every other registration linked to this person - Directus siblings
   * plus `batchSiblings`, this run's own in-flight registrations for the same person that aren't in
   * Directus yet (see `BatchSibling`; without them, two registrations newly linked to one person in
   * the same batch would each see zero siblings and both count as newest). Returns whether this
   * registration is the newest, and - regardless - the best-ranked *other* one, whose stored mirror
   * is the fallback base a field with no history of its own falls back to (#137).
   *
   * Two Directus reads, not one: it 403s a dot-notation relational filter on a scoped token (see
   * `sync-run.ts`'s `readByIds`), so this finds the person's other participants first, then their
   * registrations, rather than filtering `registrations` by `participant_id.person_id` directly.
   */
  private async rankAgainstSiblings(
    personId: string,
    registration: RegistrationRank,
    batchSiblings: readonly BatchSibling[],
  ): Promise<{ isNewest: boolean; fallbackMirror?: ParticipantMirrorFields; fallbackRegistrationId?: string }> {
    const siblingParticipants = await this.directus.readItems<ParticipantRow>("participants", {
      filter: { person_id: { _eq: personId } },
      limit: -1,
    });
    const dbMirrorByParticipantId = new Map(
      siblingParticipants
        .filter((row): row is ParticipantRow & { id: string } => row.id != null)
        .map((row) => [row.id, row]),
    );
    const dbParticipantIds = [...dbMirrorByParticipantId.keys()];
    const dbSiblingRegistrations =
      dbParticipantIds.length > 0
        ? await this.directus.readItems<RegistrationRank & { participant_id: string }>("registrations", {
            filter: { participant_id: { _in: dbParticipantIds.join(",") } },
            fields: ["id", "archived", "registered_at", "participant_id"],
            limit: -1,
          })
        : [];

    const others: Ranked<string>[] = [
      ...dbSiblingRegistrations
        .filter((sibling) => sibling.id !== registration.id)
        .map((sibling) => ({
          id: sibling.id,
          archived: sibling.archived,
          registered_at: sibling.registered_at,
          data: sibling.participant_id,
        })),
      ...batchSiblings
        .filter((sibling) => sibling.registration.id !== registration.id)
        .map((sibling) => ({ ...sibling.registration, data: sibling.participantId })),
    ];

    const isNewest = isNewestParticipant(registration, others);
    const winner = bestRanked(others);
    if (!winner) {
      return { isNewest };
    }
    const fallbackMirror =
      dbMirrorByParticipantId.get(winner.data) ??
      batchSiblings.find((sibling) => sibling.participantId === winner.data)?.mirrorFields;
    return {
      isNewest,
      fallbackRegistrationId: winner.id,
      ...(fallbackMirror ? { fallbackMirror } : {}),
    };
  }

  /** Reads the pinned person row, without re-matching - see `syncParticipant`'s `existingPersonId`. */
  private async reusePerson(personId: string): Promise<ResolvedPersonWithCurrent> {
    const [existing] = await this.directus.readItems<PersonRow>("people", { filter: { id: { _eq: personId } } });
    return existing ? { id: personId, created: false, current: existing } : { id: personId, created: false };
  }

  /**
   * Matches or creates a `people` row. `fetchCandidates` defaults to the email-then-last-name
   * search every non-participant caller wants; `syncParticipant` passes its own when the
   * participant has a date of birth. Returns the matched row itself (`current`) rather than
   * re-reading it - the caller runs the one field rule against it, rather than this method
   * deciding what to write.
   */
  private async resolvePerson(
    fields: Omit<PersonRow, "id">,
    decide: (candidates: PersonMatchCandidate[]) => PersonMatchCandidate | undefined,
    fetchCandidates: () => Promise<{ candidates: PersonMatchCandidate[]; filterDescription: string }> = () =>
      this.fetchCandidatesByEmailOrLastName(fields.email, fields.last_name),
  ): Promise<ResolvedPersonWithCurrent> {
    const { candidates, filterDescription } = await fetchCandidates();
    const match = decide(candidates);
    if (match?.id) {
      return { id: match.id, created: false, current: match };
    }

    if (candidates.length === CANDIDATE_LIMIT) {
      // The candidate fetch is a substring match capped at CANDIDATE_LIMIT rows. Hitting the cap
      // with no match can't be told apart from a real match sitting just past it, so a short last
      // name (or a common email domain) can silently create a duplicate person.
      winston.warn(
        `Candidate search for ${fields.first_name} ${fields.last_name} hit the ${CANDIDATE_LIMIT}-row limit with no match (${filterDescription}); a match may exist beyond it`,
        { firstName: fields.first_name, lastName: fields.last_name, email: fields.email },
      );
    }

    const [createdRow] = await this.directus.createItems<PersonRow>("people", [fields]);
    if (!createdRow?.id) {
      // A dry run's createItems no-ops and hands the input back with no id (see DirectusClient);
      // a placeholder, as applyPlan uses in sync-run.ts, lets contacts and medical_profiles below
      // still point somewhere. On a real write, a missing id means the create never happened.
      if (this.directus.isDryRun) {
        return { id: randomUUID(), created: true };
      }
      throw new Error("Directus did not return the created people row");
    }
    return { id: createdRow.id, created: true };
  }

  /**
   * Applies the one CRM field rule to an already-resolved existing person's `people` row. `base`
   * is this participant's own prior mirror; `fallbackMirror` is the person's previous newest
   * *other* linked participant's mirror, which a field with no history of its own falls back to
   * (#137) - see `resolveFieldBase`.
   */
  private async applySyncedPersonFields(
    personId: string,
    current: PersonRow | undefined,
    priorMirror: ParticipantRow | undefined,
    mirrorFields: ParticipantMirrorFields,
    fallbackMirror: ParticipantMirrorFields | undefined,
  ): Promise<FieldTally> {
    if (!current) {
      return emptyFieldTally();
    }
    const base = priorMirror ? personFieldValuesFromMirror(priorMirror) : undefined;
    const fallbackBase = fallbackMirror ? personFieldValuesFromMirror(fallbackMirror) : undefined;
    const v = personFieldValuesFromMirror(mirrorFields);
    const plan = planSyncedFields<PersonRow>(
      PERSON_SYNCED_FIELDS,
      current,
      resolveFieldBase<PersonRow>(base, fallbackBase),
      v,
    );
    if (Object.keys(plan.patch).length > 0) {
      await this.directus.updateItem<PersonRow>("people", personId, plan.patch);
    }
    logReplacedFields("people", personId, plan.replacedFields);
    return plan;
  }

  private async fetchCandidatesByEmailOrLastName(
    email: string | null,
    lastName: string | null,
  ): Promise<{ candidates: PersonMatchCandidate[]; filterDescription: string }> {
    if (email) {
      return this.fetchCandidatesByEmail(email);
    }
    if (lastName) {
      const candidates = await this.directus.readItems<PersonRow>("people", {
        filter: { last_name: { _icontains: lastName } },
        limit: CANDIDATE_LIMIT,
      });
      return { candidates, filterDescription: `last_name _icontains "${lastName}"` };
    }
    return { candidates: [], filterDescription: "no email or last name" };
  }

  /**
   * Unions two searches, so a person whose primary email changed still matches on an address a
   * form gave that never became primary: `people.email` by substring (below), and
   * `contact_points.normalized` by its exact value. Candidates found only through `contact_points`
   * carry their matching addresses in `knownEmails`, for `matchParticipant`/`matchGuardian`/
   * `matchEmergencyContact` to compare against alongside `email` itself.
   */
  private async fetchCandidatesByEmail(
    email: string,
  ): Promise<{ candidates: PersonMatchCandidate[]; filterDescription: string }> {
    // `_icontains`, not `_eq`: stored emails keep whatever case Clubspot sent, so an exact match
    // would miss `Foo@Bar.com` when this registration says `foo@bar.com` and create a duplicate
    // person. Directus has no case-insensitive equality, so widen the fetch and let the exact
    // normalized comparison in matchGuardian/matchParticipant do the deciding.
    const people = await this.directus.readItems<PersonRow>("people", {
      filter: { email: { _icontains: email } },
      limit: CANDIDATE_LIMIT,
    });

    const normalized = normalizeEmail(email);
    const contactPoints = normalized
      ? await this.directus.readItems<ContactPointWithParticipant>("contact_points", {
          filter: { kind: { _eq: "email" }, normalized: { _eq: normalized } },
          limit: CANDIDATE_LIMIT,
        })
      : [];

    const byId = new Map<string, PersonMatchCandidate>();
    for (const row of people) {
      if (row.id) {
        byId.set(row.id, { ...row });
      }
    }

    const unfetchedPersonIds = [...new Set(contactPoints.map((row) => row.person_id))].filter((id) => !byId.has(id));
    if (unfetchedPersonIds.length > 0) {
      const secondaryPeople = await this.directus.readItems<PersonRow>("people", {
        filter: { id: { _in: unfetchedPersonIds.join(",") } },
        limit: CANDIDATE_LIMIT,
      });
      for (const row of secondaryPeople) {
        if (row.id) {
          byId.set(row.id, { ...row });
        }
      }
    }
    for (const point of contactPoints) {
      const candidate = byId.get(point.person_id);
      if (candidate) {
        candidate.knownEmails = [...(candidate.knownEmails ?? []), point.normalized];
      }
    }

    return {
      candidates: [...byId.values()],
      filterDescription: `email _icontains "${email}" or contact_points.normalized _eq "${normalized ?? email}"`,
    };
  }

  /**
   * A participant's own match rule stops checking email once a date of birth is known (see
   * `matchParticipant`), so a different parent's email on a later registration must not hide an
   * existing row: date of birth plus last name is what identifies the child instead.
   */
  private async fetchCandidatesByDobAndLastName(
    dateOfBirth: string,
    lastName: string | null,
  ): Promise<{ candidates: PersonRow[]; filterDescription: string }> {
    const filter: Record<string, { _eq: string } | { _icontains: string }> = {
      date_of_birth: { _eq: dateOfBirth },
    };
    let filterDescription = `date_of_birth _eq "${dateOfBirth}"`;
    if (lastName) {
      filter["last_name"] = { _icontains: lastName };
      filterDescription += ` and last_name _icontains "${lastName}"`;
    }
    const candidates = await this.directus.readItems<PersonRow>("people", { filter, limit: CANDIDATE_LIMIT });
    return { candidates, filterDescription };
  }

  /**
   * Resolves or creates each guardian slot's `contacts` row, then applies the one field rule
   * (gated on `isNewest`) to whichever person that slot already pointed at - a slot linked for the
   * first time instead fills only that person's null columns, same as a brand-new match always
   * has (there's no prior mirror for this minor's link to compare against). Reports each slot's
   * current `contact_id` and this registration's email/mobile - even when the row already existed
   * and nothing changed - so `syncParticipant` can attribute those values to the right person in
   * `contact_points`.
   */
  private async syncGuardianContacts(
    participant: Participant,
    minorPersonId: string,
    priorMirror: ParticipantRow | undefined,
    mirrorFields: ParticipantMirrorFields,
    isNewest: boolean,
    fallbackMirror: ParticipantMirrorFields | undefined,
  ): Promise<{ slots: ContactPointSlot[]; fields: FieldTally; slotNameMismatches: number }> {
    const inputs = guardianInputsFromParticipant(participant);
    if (inputs.length === 0) {
      return { slots: [], fields: emptyFieldTally(), slotNameMismatches: 0 };
    }
    const existing = await this.directus.readItems<ContactRow>("contacts", {
      filter: { subject_id: { _eq: minorPersonId }, relationship_type: { _eq: "guardian" } },
    });
    const currentByContactId = await this.fetchCurrentPeople(isNewest ? existing.map((row) => row.contact_id) : []);

    let fields = emptyFieldTally();
    let slotNameMismatches = 0;
    const slots: ContactPointSlot[] = [];
    for (const input of inputs) {
      const existingContact = existing.find((row) => row.contact_order === input.contactOrder);
      const mirrorSlot: ContactMirrorSlot =
        input.contactOrder === 1
          ? {
              name: mirrorFields.guardian_1_name,
              email: mirrorFields.guardian_1_email,
              phone: mirrorFields.guardian_1_mobile,
            }
          : {
              name: mirrorFields.guardian_2_name,
              email: mirrorFields.guardian_2_email,
              phone: mirrorFields.guardian_2_mobile,
            };
      const priorSlot: ContactMirrorSlot | undefined = priorMirror
        ? input.contactOrder === 1
          ? {
              name: priorMirror.guardian_1_name,
              email: priorMirror.guardian_1_email,
              phone: priorMirror.guardian_1_mobile,
            }
          : {
              name: priorMirror.guardian_2_name,
              email: priorMirror.guardian_2_email,
              phone: priorMirror.guardian_2_mobile,
            }
        : undefined;
      const fallbackSlot: ContactMirrorSlot | undefined = fallbackMirror
        ? input.contactOrder === 1
          ? {
              name: fallbackMirror.guardian_1_name,
              email: fallbackMirror.guardian_1_email,
              phone: fallbackMirror.guardian_1_mobile,
            }
          : {
              name: fallbackMirror.guardian_2_name,
              email: fallbackMirror.guardian_2_email,
              phone: fallbackMirror.guardian_2_mobile,
            }
        : undefined;

      let contactPersonId: string;
      if (existingContact) {
        contactPersonId = existingContact.contact_id;
        if (isNewest) {
          const current = currentByContactId.get(contactPersonId);
          if (current) {
            const result = this.planContactFieldUpdate(current, priorSlot, fallbackSlot, mirrorSlot);
            if (Object.keys(result.patch).length > 0) {
              await this.directus.updateItem<PersonRow>("people", contactPersonId, result.patch);
            }
            logReplacedFields("people", contactPersonId, result.replacedFields);
            fields = addFieldTally(fields, result);
            if (result.slotNameMismatch) {
              slotNameMismatches++;
            }
          }
        }
      } else {
        const createFields = personFieldsFromGuardian(input);
        const { lastName } = splitContactName(input.fullName);
        const resolved = await this.resolvePerson(createFields, (candidates) =>
          matchGuardian(candidates, { firstName: createFields.first_name, lastName, email: input.email }),
        );
        await this.directus.createItems<ContactRow>("contacts", [
          buildGuardianContactRow(minorPersonId, resolved.id, input.contactOrder),
        ]);
        contactPersonId = resolved.id;
        if (!resolved.created && resolved.current) {
          // A slot linked to this contact for the first time - there's no minor-side history to
          // fall back to either, only a fresh fill of the contact's own null columns.
          const result = this.planContactFieldUpdate(resolved.current, undefined, undefined, mirrorSlot);
          if (Object.keys(result.patch).length > 0) {
            await this.directus.updateItem<PersonRow>("people", contactPersonId, result.patch);
          }
          fields = addFieldTally(fields, result);
        }
      }
      slots.push({ personId: contactPersonId, email: input.email, phone: input.mobile });
    }
    return { slots, fields, slotNameMismatches };
  }

  /** Same shape as {@link syncGuardianContacts}, for the emergency-contact slots. */
  private async syncEmergencyContacts(
    participant: Participant,
    minorPersonId: string,
    priorMirror: ParticipantRow | undefined,
    mirrorFields: ParticipantMirrorFields,
    isNewest: boolean,
    fallbackMirror: ParticipantMirrorFields | undefined,
  ): Promise<{ slots: ContactPointSlot[]; fields: FieldTally; slotNameMismatches: number }> {
    const inputs = emergencyContactInputsFromParticipant(participant);
    if (inputs.length === 0) {
      return { slots: [], fields: emptyFieldTally(), slotNameMismatches: 0 };
    }
    const existing = await this.directus.readItems<ContactRow>("contacts", {
      filter: { subject_id: { _eq: minorPersonId }, relationship_type: { _eq: "emergency_contact" } },
    });
    const currentByContactId = await this.fetchCurrentPeople(isNewest ? existing.map((row) => row.contact_id) : []);

    let fields = emptyFieldTally();
    let slotNameMismatches = 0;
    const slots: ContactPointSlot[] = [];
    for (const input of inputs) {
      const existingContact = existing.find((row) => row.contact_order === input.contactOrder);
      const mirrorSlot: ContactMirrorSlot =
        input.contactOrder === 1
          ? {
              name: mirrorFields.emergency_1_name,
              email: mirrorFields.emergency_1_email,
              phone: mirrorFields.emergency_1_phone,
            }
          : {
              name: mirrorFields.emergency_2_name,
              email: mirrorFields.emergency_2_email,
              phone: mirrorFields.emergency_2_phone,
            };
      const priorSlot: ContactMirrorSlot | undefined = priorMirror
        ? input.contactOrder === 1
          ? {
              name: priorMirror.emergency_1_name,
              email: priorMirror.emergency_1_email,
              phone: priorMirror.emergency_1_phone,
            }
          : {
              name: priorMirror.emergency_2_name,
              email: priorMirror.emergency_2_email,
              phone: priorMirror.emergency_2_phone,
            }
        : undefined;
      const fallbackSlot: ContactMirrorSlot | undefined = fallbackMirror
        ? input.contactOrder === 1
          ? {
              name: fallbackMirror.emergency_1_name,
              email: fallbackMirror.emergency_1_email,
              phone: fallbackMirror.emergency_1_phone,
            }
          : {
              name: fallbackMirror.emergency_2_name,
              email: fallbackMirror.emergency_2_email,
              phone: fallbackMirror.emergency_2_phone,
            }
        : undefined;

      let contactPersonId: string;
      if (existingContact) {
        contactPersonId = existingContact.contact_id;
        if (isNewest) {
          const current = currentByContactId.get(contactPersonId);
          if (current) {
            const result = this.planContactFieldUpdate(current, priorSlot, fallbackSlot, mirrorSlot);
            if (Object.keys(result.patch).length > 0) {
              await this.directus.updateItem<PersonRow>("people", contactPersonId, result.patch);
            }
            logReplacedFields("people", contactPersonId, result.replacedFields);
            fields = addFieldTally(fields, result);
            if (result.slotNameMismatch) {
              slotNameMismatches++;
            }
          }
        }
      } else {
        const createFields = personFieldsFromEmergencyContact(input);
        const resolved = await this.resolvePerson(createFields, (candidates) =>
          matchEmergencyContact(candidates, { fullName: input.fullName, phone: input.phone, email: input.email }),
        );
        await this.directus.createItems<ContactRow>("contacts", [
          buildEmergencyContactRow(minorPersonId, resolved.id, input.contactOrder, input.relationshipDetail),
        ]);
        contactPersonId = resolved.id;
        if (!resolved.created && resolved.current) {
          // A slot linked to this contact for the first time - no minor-side history to fall back
          // to either, only a fresh fill of the contact's own null columns.
          const result = this.planContactFieldUpdate(resolved.current, undefined, undefined, mirrorSlot);
          if (Object.keys(result.patch).length > 0) {
            await this.directus.updateItem<PersonRow>("people", contactPersonId, result.patch);
          }
          fields = addFieldTally(fields, result);
        }
      }
      slots.push({ personId: contactPersonId, email: input.email, phone: input.phone });
    }
    return { slots, fields, slotNameMismatches };
  }

  /** One batch read of every contact person these slots point at - empty input makes no request. */
  private async fetchCurrentPeople(personIds: readonly string[]): Promise<Map<string, PersonRow>> {
    const ids = [...new Set(personIds)];
    const byId = new Map<string, PersonRow>();
    if (ids.length === 0) {
      return byId;
    }
    const rows = await this.directus.readItems<PersonRow>("people", { filter: { id: { _in: ids.join(",") } } });
    for (const row of rows) {
      if (row.id) {
        byId.set(row.id, row);
      }
    }
    return byId;
  }

  /**
   * Plans a guardian or emergency-contact slot's field update, without writing it - the caller
   * decides whether to patch and logs any replaced staff edit, since it's the one that knows
   * whether this is a fresh link (no `base`) or an existing one.
   */
  private planContactFieldUpdate(
    current: PersonRow,
    priorSlot: ContactMirrorSlot | undefined,
    fallbackSlot: ContactMirrorSlot | undefined,
    newSlot: ContactMirrorSlot,
  ): FieldTally & { patch: Partial<PersonRow>; slotNameMismatch: boolean } {
    if (!slotNameMatchesContact(current, newSlot.name)) {
      winston.warn(
        "A guardian or emergency-contact slot's name no longer matches its linked person; skipping its field updates",
        {
          personId: current.id,
        },
      );
      return { patch: {}, ...emptyFieldTally(), slotNameMismatch: true };
    }
    const base = priorSlot ? contactFieldValuesFromMirror(priorSlot) : undefined;
    const fallbackBase = fallbackSlot ? contactFieldValuesFromMirror(fallbackSlot) : undefined;
    const v = contactFieldValuesFromMirror(newSlot);
    return {
      ...planSyncedFields<PersonRow>(
        CONTACT_SYNCED_FIELDS,
        current,
        resolveFieldBase<PersonRow>(base, fallbackBase),
        v,
      ),
      slotNameMismatch: false,
    };
  }

  /**
   * `medical_profiles` has no staff-entered data to protect - Clubspot is the only source - but a
   * profile row still ties one-to-one to a person, so a missing one is always created from
   * whatever this participant's form gives, regardless of `isNewest`. An existing row only updates
   * from the newest linked participant, under the same field rule as `people` - `fallbackMirror` is
   * the previous newest *other* linked participant's mirror, same as `applySyncedPersonFields`.
   */
  private async syncMedicalProfile(
    personId: string,
    priorMirror: ParticipantRow | undefined,
    mirrorFields: ParticipantMirrorFields,
    isNewest: boolean,
    fallbackMirror: ParticipantMirrorFields | undefined,
  ): Promise<FieldTally> {
    const existing = await this.directus.readItems<MedicalProfileRow>("medical_profiles", {
      filter: { person_id: { _eq: personId } },
    });
    const current = existing[0];
    const v = medicalFieldValuesFromMirror(mirrorFields);

    if (!current) {
      await this.directus.createItems<MedicalProfileRow>("medical_profiles", [{ person_id: personId, ...v }]);
      return emptyFieldTally();
    }
    if (!current.id || !isNewest) {
      return emptyFieldTally();
    }

    const base = priorMirror ? medicalFieldValuesFromMirror(priorMirror) : undefined;
    const fallbackBase = fallbackMirror ? medicalFieldValuesFromMirror(fallbackMirror) : undefined;
    const plan = planSyncedFields<MedicalProfileRow>(
      MEDICAL_SYNCED_FIELDS,
      current,
      resolveFieldBase<MedicalProfileRow>(base, fallbackBase),
      v,
    );
    if (Object.keys(plan.patch).length > 0) {
      await this.directus.updateItem<MedicalProfileRow>("medical_profiles", current.id, plan.patch);
    }
    logReplacedFields("medical_profiles", personId, plan.replacedFields);
    return plan;
  }
}

import { randomUUID } from "node:crypto";
import winston from "winston";
import { Participant } from "@cyc-seattle/clubspot-sdk";
import { ContactRow, MedicalProfileRow, PersonRow } from "@cyc-seattle/crm";
import { DirectusClient } from "@cyc-seattle/directus";
import { diffFields } from "./schedule.js";
import {
  buildEmergencyContactRow,
  buildGuardianContactRow,
  buildMedicalProfileFields,
  buildPersonFieldsFromParticipant,
  emergencyContactInputsFromParticipant,
  fillGapsPatch,
  guardianInputsFromParticipant,
  matchEmergencyContact,
  matchGuardian,
  matchParticipant,
  needsNewContact,
  personFieldsFromEmergencyContact,
  personFieldsFromGuardian,
  splitContactName,
} from "./people.js";

// Directus has no trigram operator over REST, so the fallback candidate fetch is a bounded
// last-name substring search rather than every row in `people`.
const CANDIDATE_LIMIT = 50;

export interface ResolvedPerson {
  id: string;
  created: boolean;
}

/**
 * Resolves and writes `people`, `contacts`, and `medical_profiles` for one Clubspot
 * `Participant`: the minor, their guardians, and their emergency contacts.
 *
 * Matching only ever runs when a row is about to be created. `syncGuardianContacts` and
 * `syncEmergencyContacts` check for an existing `contacts` row first and, if one exists, leave
 * its `contact_id` exactly as it is: that's what makes a manual merge durable, since staff repoint
 * the FK once and no later sync undoes it.
 */
export class PersonSync {
  constructor(private readonly directus: DirectusClient) {}

  /**
   * @param existingPersonId The `person_id` of this participant's own `registrations` row, if one
   *   already exists. Pinned there at creation and never re-resolved, so when it's supplied,
   *   matching is skipped entirely - re-matching on a later run, after a name gets corrected, would
   *   attach fresh medical and contact data to a second person while the registration still points
   *   at the first.
   */
  async syncParticipant(participant: Participant, existingPersonId?: string): Promise<ResolvedPerson> {
    const fields = buildPersonFieldsFromParticipant(participant);
    const resolved = existingPersonId
      ? await this.reusePerson(existingPersonId, fields)
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

    await this.syncMedicalProfile(participant, resolved.id);
    await this.syncGuardianContacts(participant, resolved.id);
    await this.syncEmergencyContacts(participant, resolved.id);

    return resolved;
  }

  /** Fills gaps on the pinned person row, same as a matched row would get, but never decides which row to use. */
  private async reusePerson(personId: string, fields: Omit<PersonRow, "id">): Promise<ResolvedPerson> {
    const [existing] = await this.directus.readItems<PersonRow>("people", { filter: { id: { _eq: personId } } });
    if (existing) {
      const patch = fillGapsPatch(existing, fields);
      if (Object.keys(patch).length > 0) {
        await this.directus.updateItem<PersonRow>("people", personId, patch);
      }
    }
    return { id: personId, created: false };
  }

  /**
   * Matches or creates a `people` row, filling gaps on an existing match but never overwriting it.
   * `fetchCandidates` defaults to the email-then-last-name search every non-participant caller
   * wants; `syncParticipant` passes its own when the participant has a date of birth.
   */
  private async resolvePerson(
    fields: Omit<PersonRow, "id">,
    decide: (candidates: PersonRow[]) => PersonRow | undefined,
    fetchCandidates: () => Promise<{ candidates: PersonRow[]; filterDescription: string }> = () =>
      this.fetchCandidatesByEmailOrLastName(fields.email, fields.last_name),
  ): Promise<ResolvedPerson> {
    const { candidates, filterDescription } = await fetchCandidates();
    const match = decide(candidates);
    if (match?.id) {
      const patch = fillGapsPatch(match, fields);
      if (Object.keys(patch).length > 0) {
        await this.directus.updateItem<PersonRow>("people", match.id, patch);
      }
      return { id: match.id, created: false };
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

  private async fetchCandidatesByEmailOrLastName(
    email: string | null,
    lastName: string | null,
  ): Promise<{ candidates: PersonRow[]; filterDescription: string }> {
    if (email) {
      // `_icontains`, not `_eq`: stored emails keep whatever case Clubspot sent, so an exact match
      // would miss `Foo@Bar.com` when this registration says `foo@bar.com` and create a duplicate
      // person. Directus has no case-insensitive equality, so widen the fetch and let the exact
      // normalized comparison in matchGuardian/matchParticipant do the deciding.
      const candidates = await this.directus.readItems<PersonRow>("people", {
        filter: { email: { _icontains: email } },
        limit: CANDIDATE_LIMIT,
      });
      return { candidates, filterDescription: `email _icontains "${email}"` };
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

  private async syncGuardianContacts(participant: Participant, minorPersonId: string): Promise<void> {
    const inputs = guardianInputsFromParticipant(participant);
    if (inputs.length === 0) {
      return;
    }
    const existing = await this.directus.readItems<ContactRow>("contacts", {
      filter: { subject_id: { _eq: minorPersonId }, relationship_type: { _eq: "guardian" } },
    });

    for (const input of inputs) {
      if (!needsNewContact(existing, input.contactOrder)) {
        continue;
      }

      const fields = personFieldsFromGuardian(input);
      const { lastName } = splitContactName(input.fullName);
      const resolved = await this.resolvePerson(fields, (candidates) =>
        matchGuardian(candidates, { firstName: fields.first_name, lastName, email: input.email }),
      );

      await this.directus.createItems<ContactRow>("contacts", [
        buildGuardianContactRow(minorPersonId, resolved.id, input.contactOrder),
      ]);
    }
  }

  private async syncEmergencyContacts(participant: Participant, minorPersonId: string): Promise<void> {
    const inputs = emergencyContactInputsFromParticipant(participant);
    if (inputs.length === 0) {
      return;
    }
    const existing = await this.directus.readItems<ContactRow>("contacts", {
      filter: { subject_id: { _eq: minorPersonId }, relationship_type: { _eq: "emergency_contact" } },
    });

    for (const input of inputs) {
      if (!needsNewContact(existing, input.contactOrder)) {
        continue;
      }

      const fields = personFieldsFromEmergencyContact(input);
      const resolved = await this.resolvePerson(fields, (candidates) =>
        matchEmergencyContact(candidates, { fullName: input.fullName, phone: input.phone, email: input.email }),
      );

      await this.directus.createItems<ContactRow>("contacts", [
        buildEmergencyContactRow(minorPersonId, resolved.id, input.contactOrder, input.relationshipDetail),
      ]);
    }
  }

  private async syncMedicalProfile(participant: Participant, personId: string): Promise<void> {
    const existing = await this.directus.readItems<MedicalProfileRow>("medical_profiles", {
      filter: { person_id: { _eq: personId } },
    });
    const fields = buildMedicalProfileFields(participant);

    const current = existing[0];
    if (!current) {
      await this.directus.createItems<MedicalProfileRow>("medical_profiles", [{ person_id: personId, ...fields }]);
      return;
    }
    if (!current.id) {
      return;
    }
    // Unlike `people`, Clubspot is the only source for medical data - there's no staff edit to
    // protect - so this tracks it exactly, including clearing a value Clubspot no longer has,
    // rather than filling gaps.
    const patch = diffFields(current, { person_id: personId, ...fields });
    if (Object.keys(patch).length > 0) {
      await this.directus.updateItem<MedicalProfileRow>("medical_profiles", current.id, patch);
    }
  }
}

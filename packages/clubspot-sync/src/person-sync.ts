import { Participant } from "@cyc-seattle/clubspot-sdk";
import { DirectusClient } from "./directus.js";
import {
  buildEmergencyContactRow,
  buildGuardianContactRow,
  buildMedicalProfileFields,
  buildPersonFieldsFromParticipant,
  ContactRow,
  emergencyContactInputsFromParticipant,
  fillGapsPatch,
  guardianInputsFromParticipant,
  matchEmergencyContact,
  matchGuardian,
  matchParticipant,
  MedicalProfileRow,
  needsNewContact,
  PersonRow,
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
 * its `person_id` exactly as it is - see the design doc's "Person identity" section for why.
 */
export class PersonSync {
  constructor(private readonly directus: DirectusClient) {}

  async syncParticipant(participant: Participant): Promise<ResolvedPerson> {
    const fields = buildPersonFieldsFromParticipant(participant);
    const resolved = await this.resolvePerson(fields, (candidates) =>
      matchParticipant(candidates, {
        firstName: fields.first_name,
        lastName: fields.last_name,
        dateOfBirth: fields.date_of_birth,
        email: fields.email,
      }),
    );

    await this.syncMedicalProfile(participant, resolved.id);
    await this.syncGuardianContacts(participant, resolved.id);
    await this.syncEmergencyContacts(participant, resolved.id);

    return resolved;
  }

  /** Matches or creates a `people` row, filling gaps on an existing match but never overwriting it. */
  private async resolvePerson(
    fields: Omit<PersonRow, "id">,
    decide: (candidates: PersonRow[]) => PersonRow | undefined,
  ): Promise<ResolvedPerson> {
    const candidates = await this.fetchCandidates(fields.email, fields.last_name);
    const match = decide(candidates);
    if (match?.id) {
      const patch = fillGapsPatch(match, fields);
      if (Object.keys(patch).length > 0) {
        await this.directus.updateItem<PersonRow>("people", match.id, patch);
      }
      return { id: match.id, created: false };
    }

    const [createdRow] = await this.directus.createItems<PersonRow>("people", [fields]);
    if (!createdRow?.id) {
      throw new Error("Directus did not return the created people row");
    }
    return { id: createdRow.id, created: true };
  }

  private async fetchCandidates(email: string | null, lastName: string | null): Promise<PersonRow[]> {
    if (email) {
      return this.directus.readItems<PersonRow>("people", { filter: { email: { _eq: email } } });
    }
    if (lastName) {
      return this.directus.readItems<PersonRow>("people", {
        filter: { last_name: { _icontains: lastName } },
        limit: CANDIDATE_LIMIT,
      });
    }
    return [];
  }

  private async syncGuardianContacts(participant: Participant, minorPersonId: string): Promise<void> {
    const inputs = guardianInputsFromParticipant(participant);
    if (inputs.length === 0) {
      return;
    }
    const existing = await this.directus.readItems<ContactRow>("contacts", {
      filter: { related_person_id: { _eq: minorPersonId }, relationship_type: { _eq: "guardian" } },
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
      filter: { related_person_id: { _eq: minorPersonId }, relationship_type: { _eq: "emergency_contact" } },
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
    const patch = fillGapsPatch(current, fields);
    if (Object.keys(patch).length > 0) {
      await this.directus.updateItem<MedicalProfileRow>("medical_profiles", current.id, patch);
    }
  }
}

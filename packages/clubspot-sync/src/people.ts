import { Participant } from "@cyc-seattle/clubspot-sdk";
import { ContactRow, MedicalProfileRow, PersonRow } from "@cyc-seattle/crm";

/**
 * `contacts.person_id` and `registrations.person_id` are resolved once, when the row that points
 * at them is created, and never re-resolved. The pure functions here decide whether a candidate
 * matches; `person-sync.ts` is the thin, impure executor that fetches candidates and creates or
 * updates rows around that decision.
 */

export function normalizeName(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** `undefined`/empty-string Clubspot fields both mean "no value" - collapse them to `null`. */
function toNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * True when `a` and `b` differ by at most one character insertion, deletion, or substitution.
 * Used only for a guardian's first name, e.g. a "Jon"/"John" typo - it must not match "Bob"
 * against "Robert".
 */
export function isWithinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) {
    return false;
  }

  const sameLength = shorter.length === longer.length;
  let shortIndex = 0;
  let longIndex = 0;
  let usedEdit = false;

  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      longIndex++;
      continue;
    }
    if (usedEdit) {
      return false;
    }
    usedEdit = true;
    longIndex++;
    if (sameLength) {
      shortIndex++;
    }
  }
  return true;
}

export interface SplitName {
  firstName: string;
  lastName: string | null;
}

/**
 * Splits a free-text contact name ("Jane Doe") on the first space. `people.first_name` isn't
 * nullable, so a single token becomes the first name with no last name, rather than the reverse.
 */
export function splitContactName(fullName: string): SplitName {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { firstName: trimmed, lastName: null };
  }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}

/**
 * Fills only the fields of `existing` that are currently null, from `incoming`. A field that
 * already holds a value is left alone - that's what keeps a staff edit, or a merge, from being
 * overwritten by the next registration that names the same person.
 */
export function fillGapsPatch<Row extends { id?: string }>(existing: Row, incoming: Partial<Row>): Partial<Row> {
  const patch: Partial<Row> = {};
  for (const key of Object.keys(incoming) as (keyof Row)[]) {
    if (key === "id") {
      continue;
    }
    const incomingValue = incoming[key];
    if (incomingValue === undefined || incomingValue === null) {
      continue;
    }
    if (existing[key] === null || existing[key] === undefined) {
      patch[key] = incomingValue;
    }
  }
  return patch;
}

// At least one real row holds "1", which isn't a plausible weight for a camper. A floor catches
// that kind of junk without guessing at an upper bound.
const MIN_PLAUSIBLE_WEIGHT_LBS = 10;

/** Parses Clubspot's numeric-string `weight`, dropping anything that isn't a plausible integer. */
export function parseWeight(raw: string | null | undefined): number | null {
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return value >= MIN_PLAUSIBLE_WEIGHT_LBS ? value : null;
}

export interface ParticipantMatchInput {
  firstName: string;
  lastName: string | null;
  dateOfBirth: string | null;
  email: string | null;
}

/** Same normalized first and last name, and the same date of birth; without one, also the same email. */
export function matchParticipant(
  candidates: readonly PersonRow[],
  input: ParticipantMatchInput,
): PersonRow | undefined {
  const firstName = normalizeName(input.firstName);
  const lastName = normalizeName(input.lastName);

  return candidates.find((candidate) => {
    if (normalizeName(candidate.first_name) !== firstName) {
      return false;
    }
    if (normalizeName(candidate.last_name) !== lastName) {
      return false;
    }
    if (input.dateOfBirth) {
      return candidate.date_of_birth === input.dateOfBirth;
    }
    const email = normalizeEmail(input.email);
    return email !== null && normalizeEmail(candidate.email) === email;
  });
}

export interface GuardianMatchInput {
  firstName: string;
  lastName: string | null;
  email: string | null;
}

/**
 * Same normalized email and last name, with the first name allowed one edit. An email alone is
 * never a match - families share one address across two different adults - so email, last name,
 * and first name are all required.
 */
export function matchGuardian(candidates: readonly PersonRow[], input: GuardianMatchInput): PersonRow | undefined {
  const email = normalizeEmail(input.email);
  const lastName = normalizeName(input.lastName);
  const firstName = normalizeName(input.firstName);
  if (!email || !lastName || !firstName) {
    return undefined;
  }

  return candidates.find((candidate) => {
    if (normalizeEmail(candidate.email) !== email) {
      return false;
    }
    if (normalizeName(candidate.last_name) !== lastName) {
      return false;
    }
    const candidateFirstName = normalizeName(candidate.first_name);
    return candidateFirstName !== null && isWithinEditDistanceOne(candidateFirstName, firstName);
  });
}

export interface EmergencyContactMatchInput {
  fullName: string;
  phone: string | null;
  email: string | null;
}

function candidateFullName(candidate: PersonRow): string | null {
  return normalizeName(`${candidate.first_name} ${candidate.last_name ?? ""}`);
}

/**
 * Same normalized full name and phone. Clubspot's `emergencyEmail` is filled on roughly 1 of 168
 * real participants, so it's used when present; otherwise name plus phone is the working path.
 */
export function matchEmergencyContact(
  candidates: readonly PersonRow[],
  input: EmergencyContactMatchInput,
): PersonRow | undefined {
  const fullName = normalizeName(input.fullName);
  if (!fullName) {
    return undefined;
  }

  const email = normalizeEmail(input.email);
  if (email) {
    return candidates.find(
      (candidate) => candidateFullName(candidate) === fullName && normalizeEmail(candidate.email) === email,
    );
  }

  const phone = normalizePhone(input.phone);
  if (!phone) {
    return undefined;
  }
  return candidates.find(
    (candidate) => candidateFullName(candidate) === fullName && normalizePhone(candidate.phone) === phone,
  );
}

/**
 * Whether a (minor, order) pair still needs a new `contacts` row. Once one exists, its
 * `person_id` is never recomputed - this is what makes a manual merge durable.
 */
export function needsNewContact(existing: readonly ContactRow[], contactOrder: number): boolean {
  return !existing.some((row) => row.contact_order === contactOrder);
}

// Clubspot dates are UTC, and `date_of_birth` is a Directus `date` column, so a plain calendar
// date string is all it holds (see schedule.ts's toDateString for the same reasoning).
function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Maps the minor's own fields directly - Clubspot already splits `Participant.firstName`/`lastName`.
 * `people.first_name` is NOT NULL, but the SDK's `firstName` is optional; an empty string would
 * normalize to the same "no name" as every other nameless row and false-merge their medical data.
 */
export function buildPersonFieldsFromParticipant(participant: Participant): Omit<PersonRow, "id"> {
  const firstName = toNullableText(participant.get("firstName"));
  if (!firstName) {
    throw new Error(`Participant ${participant.id} has no firstName; people.first_name is not nullable`);
  }
  const dob = participant.get("DOB");
  return {
    first_name: firstName,
    last_name: toNullableText(participant.get("lastName")),
    email: toNullableText(participant.get("email")),
    phone: toNullableText(participant.get("mobile")),
    date_of_birth: dob ? toDateString(dob) : null,
    gender: toNullableText(participant.get("gender")),
    street: toNullableText(participant.get("street")),
    city: toNullableText(participant.get("city")),
    state: toNullableText(participant.get("state")),
    postal_code: toNullableText(participant.get("zip")),
  };
}

export interface GuardianInput {
  fullName: string;
  email: string | null;
  mobile: string | null;
  contactOrder: number;
}

/** Clubspot carries a primary and a secondary guardian as flat fields on the participant. */
export function guardianInputsFromParticipant(participant: Participant): GuardianInput[] {
  const inputs: GuardianInput[] = [];

  const primaryName = toNullableText(participant.get("parentGuardianName"));
  if (primaryName) {
    inputs.push({
      fullName: primaryName,
      email: toNullableText(participant.get("parentGuardianEmail")),
      mobile: toNullableText(participant.get("parentGuardianMobile")),
      contactOrder: 1,
    });
  }

  const secondaryName = toNullableText(participant.get("parentGuardianName_secondary"));
  if (secondaryName) {
    inputs.push({
      fullName: secondaryName,
      email: toNullableText(participant.get("parentGuardianEmail_secondary")),
      mobile: toNullableText(participant.get("parentGuardianMobile_secondary")),
      contactOrder: 2,
    });
  }

  return inputs;
}

export interface EmergencyContactInput {
  fullName: string;
  phone: string | null;
  email: string | null;
  relationshipDetail: string | null;
  contactOrder: number;
}

/** Clubspot carries a primary and a secondary emergency contact as flat fields on the participant. */
export function emergencyContactInputsFromParticipant(participant: Participant): EmergencyContactInput[] {
  const inputs: EmergencyContactInput[] = [];

  const primaryName = toNullableText(participant.get("emergencyContact"));
  if (primaryName) {
    inputs.push({
      fullName: primaryName,
      phone: toNullableText(participant.get("emergencyMobile")),
      email: toNullableText(participant.get("emergencyEmail")),
      relationshipDetail: toNullableText(participant.get("emergencyRelationship")),
      contactOrder: 1,
    });
  }

  const secondaryName = toNullableText(participant.get("emergencyContact_secondary"));
  if (secondaryName) {
    inputs.push({
      fullName: secondaryName,
      phone: toNullableText(participant.get("emergencyMobile_secondary")),
      email: toNullableText(participant.get("emergencyEmail_secondary")),
      relationshipDetail: toNullableText(participant.get("emergencyRelationship_secondary")),
      contactOrder: 2,
    });
  }

  return inputs;
}

/** A guardian is only ever known by a free-text name, so it goes through {@link splitContactName}. */
export function personFieldsFromGuardian(input: GuardianInput): Omit<PersonRow, "id"> {
  const { firstName, lastName } = splitContactName(input.fullName);
  return {
    first_name: firstName,
    last_name: lastName,
    email: input.email,
    phone: input.mobile,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
  };
}

export function personFieldsFromEmergencyContact(input: EmergencyContactInput): Omit<PersonRow, "id"> {
  const { firstName, lastName } = splitContactName(input.fullName);
  return {
    first_name: firstName,
    last_name: lastName,
    email: input.email,
    phone: input.phone,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
  };
}

export function buildGuardianContactRow(
  relatedPersonId: string,
  personId: string,
  contactOrder: number,
): Omit<ContactRow, "id"> {
  return {
    related_person_id: relatedPersonId,
    person_id: personId,
    relationship_type: "guardian",
    contact_order: contactOrder,
    relationship_detail: null,
  };
}

export function buildEmergencyContactRow(
  relatedPersonId: string,
  personId: string,
  contactOrder: number,
  relationshipDetail: string | null,
): Omit<ContactRow, "id"> {
  return {
    related_person_id: relatedPersonId,
    person_id: personId,
    relationship_type: "emergency_contact",
    contact_order: contactOrder,
    relationship_detail: relationshipDetail,
  };
}

export function buildMedicalProfileFields(participant: Participant): Omit<MedicalProfileRow, "id" | "person_id"> {
  return {
    conditions: toNullableText(participant.get("medical")),
    allergies: toNullableText(participant.get("medical_allergies")),
    medications: toNullableText(participant.get("medical_meds")),
    last_tetanus: toNullableText(participant.get("medical_tetanus")),
    physician_name: toNullableText(participant.get("pcpName")),
    physician_phone: toNullableText(participant.get("pcpNumber")),
    weight: parseWeight(participant.get("weight")),
  };
}

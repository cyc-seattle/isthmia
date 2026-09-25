import { Participant } from "@cyc-seattle/clubspot-sdk";
import { ContactRow, MedicalProfileRow, PersonRow } from "@cyc-seattle/crm";
import { ParticipantRow } from "@cyc-seattle/clubspot";

/**
 * `contacts.contact_id` and `registrations.person_id` are resolved once, when the row that points
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

/**
 * A `people` candidate for matching, optionally carrying every other normalized email
 * `contact_points` attributes to it - a search that unions `contact_points` populates this so a
 * person whose primary email changed still matches on an address a form gave that never became
 * primary. See `PersonSync`'s email candidate fetch.
 */
export interface PersonMatchCandidate extends PersonRow {
  knownEmails?: readonly string[];
}

function candidateHasEmail(candidate: PersonMatchCandidate, email: string): boolean {
  return normalizeEmail(candidate.email) === email || (candidate.knownEmails ?? []).includes(email);
}

export interface ParticipantMatchInput {
  firstName: string;
  lastName: string | null;
  dateOfBirth: string | null;
  email: string | null;
}

/** Same normalized first and last name, and the same date of birth; without one, also the same email. */
export function matchParticipant(
  candidates: readonly PersonMatchCandidate[],
  input: ParticipantMatchInput,
): PersonMatchCandidate | undefined {
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
    return email !== null && candidateHasEmail(candidate, email);
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
export function matchGuardian(
  candidates: readonly PersonMatchCandidate[],
  input: GuardianMatchInput,
): PersonMatchCandidate | undefined {
  const email = normalizeEmail(input.email);
  const lastName = normalizeName(input.lastName);
  const firstName = normalizeName(input.firstName);
  if (!email || !lastName || !firstName) {
    return undefined;
  }

  return candidates.find((candidate) => {
    if (!candidateHasEmail(candidate, email)) {
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

function candidateFullName(candidate: PersonMatchCandidate): string | null {
  return normalizeName(`${candidate.first_name} ${candidate.last_name ?? ""}`);
}

/**
 * Same normalized full name and phone. Clubspot's `emergencyEmail` is filled on roughly 1 of 168
 * real participants, so it's used when present; otherwise name plus phone is the working path.
 */
export function matchEmergencyContact(
  candidates: readonly PersonMatchCandidate[],
  input: EmergencyContactMatchInput,
): PersonMatchCandidate | undefined {
  const fullName = normalizeName(input.fullName);
  if (!fullName) {
    return undefined;
  }

  const email = normalizeEmail(input.email);
  if (email) {
    return candidates.find(
      (candidate) => candidateFullName(candidate) === fullName && candidateHasEmail(candidate, email),
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

// Clubspot dates are UTC, and `date_of_birth` is a Directus `date` column, so a plain calendar
// date string is all it holds (see schedule.ts's toDateString for the same reasoning).
export function toDateString(date: Date): string {
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
  subjectId: string,
  contactId: string,
  contactOrder: number,
): Omit<ContactRow, "id"> {
  return {
    subject_id: subjectId,
    contact_id: contactId,
    relationship_type: "guardian",
    contact_order: contactOrder,
    relationship_detail: null,
  };
}

export function buildEmergencyContactRow(
  subjectId: string,
  contactId: string,
  contactOrder: number,
  relationshipDetail: string | null,
): Omit<ContactRow, "id"> {
  return {
    subject_id: subjectId,
    contact_id: contactId,
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

export type ParticipantMirrorFields = Omit<ParticipantRow, "id" | "person_id" | "last_sync_run_id">;

/**
 * `participants` mirrors the registration form exactly as Clubspot sent it - no trimming, no
 * empty-string collapsing, no weight parsing - so it stays a faithful record of what the form
 * said even where the builders above normalize or reject the same value. Only `DOB` is converted,
 * since `date_of_birth` is a Directus `date` column and a Parse `Date` object isn't a value the
 * REST API can write.
 */
export function buildParticipantMirrorFields(participant: Participant): ParticipantMirrorFields {
  const dob = participant.get("DOB");
  return {
    first_name: participant.get("firstName") ?? null,
    last_name: participant.get("lastName") ?? null,
    email: participant.get("email") ?? null,
    phone: participant.get("mobile") ?? null,
    date_of_birth: dob ? toDateString(dob) : null,
    gender: participant.get("gender") ?? null,
    street: participant.get("street") ?? null,
    city: participant.get("city") ?? null,
    state: participant.get("state") ?? null,
    postal_code: participant.get("zip") ?? null,
    guardian_1_name: participant.get("parentGuardianName") ?? null,
    guardian_1_email: participant.get("parentGuardianEmail") ?? null,
    guardian_1_mobile: participant.get("parentGuardianMobile") ?? null,
    guardian_2_name: participant.get("parentGuardianName_secondary") ?? null,
    guardian_2_email: participant.get("parentGuardianEmail_secondary") ?? null,
    guardian_2_mobile: participant.get("parentGuardianMobile_secondary") ?? null,
    emergency_1_name: participant.get("emergencyContact") ?? null,
    emergency_1_phone: participant.get("emergencyMobile") ?? null,
    emergency_1_email: participant.get("emergencyEmail") ?? null,
    emergency_1_relationship: participant.get("emergencyRelationship") ?? null,
    emergency_2_name: participant.get("emergencyContact_secondary") ?? null,
    emergency_2_phone: participant.get("emergencyMobile_secondary") ?? null,
    emergency_2_email: participant.get("emergencyEmail_secondary") ?? null,
    emergency_2_relationship: participant.get("emergencyRelationship_secondary") ?? null,
    medical_conditions: participant.get("medical") ?? null,
    medical_allergies: participant.get("medical_allergies") ?? null,
    medical_medications: participant.get("medical_meds") ?? null,
    medical_last_tetanus: participant.get("medical_tetanus") ?? null,
    medical_physician_name: participant.get("pcpName") ?? null,
    medical_physician_phone: participant.get("pcpNumber") ?? null,
    medical_weight: participant.get("weight") ?? null,
  };
}

/**
 * The CRM-shaped value each of the participant's own `people` fields becomes, from a stored
 * `participants` row instead of a live `Participant` - unlike `PersonRow`, `first_name` is
 * nullable here, since the one CRM field rule (#137) has to weigh a blank mirror value against
 * whatever base it held, even where `people.first_name` itself is NOT NULL. Built with the same
 * primitives (`toNullableText`) `buildPersonFieldsFromParticipant` uses, so a mirror row's prior
 * and current values compare on equal footing.
 */
export type PersonFieldValues = { [K in keyof Omit<PersonRow, "id" | "school">]: PersonRow[K] | null };

export function personFieldValuesFromMirror(
  mirror: Pick<
    ParticipantMirrorFields,
    | "first_name"
    | "last_name"
    | "email"
    | "phone"
    | "date_of_birth"
    | "gender"
    | "street"
    | "city"
    | "state"
    | "postal_code"
  >,
): PersonFieldValues {
  return {
    first_name: toNullableText(mirror.first_name),
    last_name: toNullableText(mirror.last_name),
    email: toNullableText(mirror.email),
    phone: toNullableText(mirror.phone),
    date_of_birth: mirror.date_of_birth,
    gender: toNullableText(mirror.gender),
    street: toNullableText(mirror.street),
    city: toNullableText(mirror.city),
    state: toNullableText(mirror.state),
    postal_code: toNullableText(mirror.postal_code),
  };
}

export interface ContactMirrorValues {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

/** One guardian or emergency-contact slot's raw mirror values - `mobile`/`phone` already renamed to a common `phone` by the caller. */
export interface ContactMirrorSlot {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Same reasoning as {@link personFieldValuesFromMirror}, for a guardian or emergency-contact slot. */
export function contactFieldValuesFromMirror(slot: ContactMirrorSlot): ContactMirrorValues {
  const trimmedName = slot.name?.trim();
  const split = trimmedName ? splitContactName(trimmedName) : undefined;
  return {
    first_name: split?.firstName ?? null,
    last_name: split?.lastName ?? null,
    email: toNullableText(slot.email),
    phone: toNullableText(slot.phone),
  };
}

/**
 * True when `newFullName`, once split, still names the same person as `contact` currently does.
 * Guards a guardian or emergency-contact slot's field updates (#137): a slot's name changing
 * entirely - not just a spelling correction - usually means Clubspot now has a different adult in
 * that slot, and applying its email or phone to the previously-linked person would be wrong.
 */
export function slotNameMatchesContact(
  contact: Pick<PersonRow, "first_name" | "last_name">,
  newFullName: string | null,
): boolean {
  if (!newFullName) {
    return true;
  }
  const { firstName, lastName } = splitContactName(newFullName);
  return (
    normalizeName(contact.first_name) === normalizeName(firstName) &&
    normalizeName(contact.last_name) === normalizeName(lastName)
  );
}

export type MedicalMirrorValues = Omit<MedicalProfileRow, "id" | "person_id">;

/** Same reasoning as {@link personFieldValuesFromMirror}, for `medical_profiles`. */
export function medicalFieldValuesFromMirror(
  mirror: Pick<
    ParticipantMirrorFields,
    | "medical_conditions"
    | "medical_allergies"
    | "medical_medications"
    | "medical_last_tetanus"
    | "medical_physician_name"
    | "medical_physician_phone"
    | "medical_weight"
  >,
): MedicalMirrorValues {
  return {
    conditions: toNullableText(mirror.medical_conditions),
    allergies: toNullableText(mirror.medical_allergies),
    medications: toNullableText(mirror.medical_medications),
    last_tetanus: toNullableText(mirror.medical_last_tetanus),
    physician_name: toNullableText(mirror.medical_physician_name),
    physician_phone: toNullableText(mirror.medical_physician_phone),
    weight: parseWeight(mirror.medical_weight),
  };
}

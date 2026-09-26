import { normalizeName } from "./people.js";

/**
 * Pure planning for merging duplicate `people` rows (design doc "Merge, unmerge, and review",
 * #133). `findDuplicatePeople` proposes a keeper for a group of same-named rows;
 * `planPersonMerge` turns one approved group into an ordered, explicit list of writes. Both are
 * pure - a later step's executor reads the candidates and related rows from Directus and applies
 * the plan, and is the only thing that touches the network.
 */

export interface HandledPeopleForeignKey {
  collection: string;
  field: string;
}

/**
 * Every FK to `people` this merge repoints, folds, or deletes through. The FK-coverage test
 * (`test/merge-fk-coverage.test.ts`) reads every package's `schema.yaml` and fails if a relation
 * to `people` is missing from this list - a merge that misses one would either leave a dangling
 * reference or, once `on_delete: RESTRICT` ships, fail loudly on the final delete instead.
 */
export const HANDLED_PEOPLE_FOREIGN_KEYS: readonly HandledPeopleForeignKey[] = [
  { collection: "contacts", field: "subject_id" },
  { collection: "contacts", field: "contact_id" },
  { collection: "medical_profiles", field: "person_id" },
  { collection: "program_role_assignments", field: "person_id" },
  { collection: "contact_points", field: "person_id" },
  { collection: "event_staff", field: "person_id" },
  { collection: "participants", field: "person_id" },
];

/** A `people` row as the merge needs it - every scalar column, plus `directus_user_id` (`packages/directus/schema.yaml`'s extension field). */
export interface MergePerson {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  school: string | null;
  directus_user_id: string | null;
}

const PERSON_SCALAR_FIELDS: readonly (keyof Omit<MergePerson, "id" | "directus_user_id">)[] = [
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
  "school",
];

/** Every `MergePerson` field, for a Directus read that projects onto exactly this shape - shared
 * by the duplicate-detection pass and the merge executor's own re-read of a group. */
export const MERGE_PERSON_FIELDS: readonly (keyof MergePerson)[] = [
  "id",
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
  "school",
  "directus_user_id",
];

export interface MergeParticipant {
  id: string;
  person_id: string | null;
}

export interface MergeMedicalProfile {
  id: string;
  person_id: string;
  allergies: string | null;
  medications: string | null;
  conditions: string | null;
  physician_name: string | null;
  physician_phone: string | null;
  last_tetanus: string | null;
  weight: number | null;
}

export type ContactRelationshipType = "guardian" | "emergency_contact";

export interface MergeContact {
  id: string;
  subject_id: string;
  contact_id: string;
  relationship_type: ContactRelationshipType;
}

export interface MergeContactPoint {
  id: string;
  person_id: string;
  kind: "email" | "phone";
  normalized: string;
}

export interface MergePersonReference {
  id: string;
  person_id: string;
}

/** The rows the merge needs across the whole group (the keeper and every duplicate) - already narrowed to those referencing one of them. */
export interface MergeRelatedData {
  participants: readonly MergeParticipant[];
  medicalProfiles: readonly MergeMedicalProfile[];
  contacts: readonly MergeContact[];
  contactPoints: readonly MergeContactPoint[];
  programRoleAssignments: readonly MergePersonReference[];
  eventStaff: readonly MergePersonReference[];
}

export interface MergeUpdateStep {
  readonly type: "update";
  readonly collection: string;
  readonly id: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface MergeDeleteStep {
  readonly type: "delete";
  readonly collection: string;
  readonly ids: readonly string[];
}

export type MergeStep = MergeUpdateStep | MergeDeleteStep;

export interface DuplicatePersonMember {
  id: string;
  date_of_birth: string | null;
}

export interface DuplicatePersonGroup {
  keeperId: string;
  /** Every row in the group, keeper included, for the `duplicate_person` finding's `detail`. */
  members: readonly DuplicatePersonMember[];
}

/** The normalized full name that groups duplicates - exported so the merge executor can re-check
 * a finding's group still shares one before it re-applies the plan. */
export function groupKey(person: Pick<MergePerson, "first_name" | "last_name">): string | null {
  return normalizeName(`${person.first_name} ${person.last_name ?? ""}`);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Most linked participants; tie to a `directus_user_id`; tie to the smallest id. Negative means `a` should win over `b`. */
function compareKeeperCandidates(
  a: MergePerson,
  b: MergePerson,
  participantsByPerson: ReadonlyMap<string, readonly { readonly id: string }[]>,
): number {
  const countDiff = (participantsByPerson.get(b.id)?.length ?? 0) - (participantsByPerson.get(a.id)?.length ?? 0);
  if (countDiff !== 0) {
    return countDiff;
  }
  const directusDiff = Number(b.directus_user_id != null) - Number(a.directus_user_id != null);
  if (directusDiff !== 0) {
    return directusDiff;
  }
  return compareIds(a.id, b.id);
}

function chooseKeeper(
  people: readonly MergePerson[],
  participantsByPerson: ReadonlyMap<string, readonly { readonly id: string }[]>,
): MergePerson {
  const [first, ...rest] = people;
  if (first === undefined) {
    throw new Error("chooseKeeper requires at least one candidate");
  }
  return rest.reduce(
    (best, candidate) => (compareKeeperCandidates(candidate, best, participantsByPerson) < 0 ? candidate : best),
    first,
  );
}

/**
 * Groups people sharing a normalized first-plus-last name, each with a proposed keeper. Nothing
 * here excludes a person for having no last name or an otherwise generic name - the doc's staff
 * review, not this function, is what dismisses a bad grouping.
 */
export function findDuplicatePeople(
  people: readonly MergePerson[],
  participantsByPerson: ReadonlyMap<string, readonly { readonly id: string }[]>,
): DuplicatePersonGroup[] {
  const buckets = new Map<string, MergePerson[]>();
  for (const person of people) {
    const key = groupKey(person);
    if (key === null) {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(person);
    } else {
      buckets.set(key, [person]);
    }
  }

  const groups: DuplicatePersonGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) {
      continue;
    }
    const keeper = chooseKeeper(bucket, participantsByPerson);
    groups.push({
      keeperId: keeper.id,
      members: bucket
        .map((person) => ({ id: person.id, date_of_birth: person.date_of_birth }))
        .sort((a, b) => compareIds(a.id, b.id)),
    });
  }
  return groups;
}

/**
 * Folds every medical profile in the group onto one surviving row - the keeper's own profile if
 * it has one, otherwise the first duplicate's. The survivor's null fields are filled from the
 * rest, in the given order, before the rest are deleted; `person_id` is unique, so two profiles
 * can never coexist under the keeper.
 */
function planMedicalProfileMerge(keeper: MergePerson, profiles: readonly MergeMedicalProfile[]): MergeStep[] {
  const others = profiles.filter((profile) => profile.person_id !== keeper.id);
  const [firstOther] = others;
  if (firstOther === undefined) {
    return [];
  }
  const keeperProfile = profiles.find((profile) => profile.person_id === keeper.id);
  const survivor = keeperProfile ?? firstOther;
  const rest = others.filter((profile) => profile.id !== survivor.id);

  const fields: readonly (keyof Omit<MergeMedicalProfile, "id" | "person_id">)[] = [
    "allergies",
    "medications",
    "conditions",
    "physician_name",
    "physician_phone",
    "last_tetanus",
    "weight",
  ];
  const patch: Record<string, unknown> = {};
  if (survivor.person_id !== keeper.id) {
    patch["person_id"] = keeper.id;
  }
  for (const field of fields) {
    if (survivor[field] == null) {
      const fill = others.find((profile) => profile[field] != null);
      if (fill) {
        patch[field] = fill[field];
      }
    }
  }

  const steps: MergeStep[] = [];
  if (Object.keys(patch).length > 0) {
    steps.push({ type: "update", collection: "medical_profiles", id: survivor.id, patch });
  }
  if (rest.length > 0) {
    steps.push({ type: "delete", collection: "medical_profiles", ids: rest.map((profile) => profile.id) });
  }
  return steps;
}

/**
 * Repoints `subject_id`/`contact_id` off every duplicate onto the keeper, then drops any contact
 * that repointing turned self-referential, and any contact that collapsed onto another one's
 * (`subject_id`, `contact_id`, `relationship_type`). A contact that needed no repointing always
 * keeps its key over one that did, so a merge never rewrites a row it didn't have to.
 */
function planContactMerge(
  keeperId: string,
  duplicateIds: ReadonlySet<string>,
  contacts: readonly MergeContact[],
): MergeStep[] {
  const remap = (personId: string) => (duplicateIds.has(personId) ? keeperId : personId);
  const needsRepoint = (contact: MergeContact) =>
    duplicateIds.has(contact.subject_id) || duplicateIds.has(contact.contact_id);
  const key = (subjectId: string, contactId: string, relationshipType: ContactRelationshipType) =>
    `${subjectId}:${contactId}:${relationshipType}`;

  const claimedKeys = new Set(
    contacts
      .filter((contact) => !needsRepoint(contact))
      .map((contact) => key(contact.subject_id, contact.contact_id, contact.relationship_type)),
  );

  const updates: MergeUpdateStep[] = [];
  const deleteIds: string[] = [];
  for (const contact of contacts.filter(needsRepoint)) {
    const subjectId = remap(contact.subject_id);
    const contactId = remap(contact.contact_id);
    if (subjectId === contactId) {
      deleteIds.push(contact.id);
      continue;
    }
    const contactKey = key(subjectId, contactId, contact.relationship_type);
    if (claimedKeys.has(contactKey)) {
      deleteIds.push(contact.id);
      continue;
    }
    claimedKeys.add(contactKey);
    updates.push({
      type: "update",
      collection: "contacts",
      id: contact.id,
      patch: { subject_id: subjectId, contact_id: contactId },
    });
  }

  const steps: MergeStep[] = [...updates];
  if (deleteIds.length > 0) {
    steps.push({ type: "delete", collection: "contacts", ids: deleteIds });
  }
  return steps;
}

/**
 * Repoints `person_id` off every duplicate onto the keeper, then drops any point that collapsed
 * onto another's (`person_id`, `kind`, `normalized`) - the same upsert key `contact-points.ts`
 * uses, so the union survives with no duplicate. A point that needed no repointing always keeps
 * its key over one that did, for the same reason `planContactMerge` does.
 */
function planContactPointMerge(
  keeperId: string,
  duplicateIds: ReadonlySet<string>,
  points: readonly MergeContactPoint[],
): MergeStep[] {
  const remap = (personId: string) => (duplicateIds.has(personId) ? keeperId : personId);
  const needsRepoint = (point: MergeContactPoint) => duplicateIds.has(point.person_id);
  const key = (personId: string, kind: string, normalized: string) => `${personId}:${kind}:${normalized}`;

  const claimedKeys = new Set(
    points.filter((point) => !needsRepoint(point)).map((point) => key(point.person_id, point.kind, point.normalized)),
  );

  const updates: MergeUpdateStep[] = [];
  const deleteIds: string[] = [];
  for (const point of points.filter(needsRepoint)) {
    const personId = remap(point.person_id);
    const pointKey = key(personId, point.kind, point.normalized);
    if (claimedKeys.has(pointKey)) {
      deleteIds.push(point.id);
      continue;
    }
    claimedKeys.add(pointKey);
    updates.push({ type: "update", collection: "contact_points", id: point.id, patch: { person_id: personId } });
  }

  const steps: MergeStep[] = [...updates];
  if (deleteIds.length > 0) {
    steps.push({ type: "delete", collection: "contact_points", ids: deleteIds });
  }
  return steps;
}

/** `program_role_assignments` and `event_staff` just repoint - the doc asks for no de-dup on either. */
function planSimpleRepoint(
  collection: string,
  keeperId: string,
  duplicateIds: ReadonlySet<string>,
  rows: readonly MergePersonReference[],
): MergeStep[] {
  return rows
    .filter((row) => duplicateIds.has(row.person_id))
    .map((row): MergeUpdateStep => ({ type: "update", collection, id: row.id, patch: { person_id: keeperId } }));
}

/**
 * The keeper's own row: its non-null scalars win, a duplicate's non-null value fills only a null
 * one, taken in the given order. `directus_user_id` is separate - it isn't filled, it's moved -
 * and only when exactly one row in the whole group holds one.
 */
function buildKeeperPersonPatch(keeper: MergePerson, duplicates: readonly MergePerson[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of PERSON_SCALAR_FIELDS) {
    if (keeper[field] == null) {
      const fill = duplicates.find((duplicate) => duplicate[field] != null);
      if (fill) {
        patch[field] = fill[field];
      }
    }
  }

  const duplicateWithDirectusUser = duplicates.find((duplicate) => duplicate.directus_user_id != null);
  if (keeper.directus_user_id == null && duplicateWithDirectusUser) {
    patch["directus_user_id"] = duplicateWithDirectusUser.directus_user_id;
  }

  return patch;
}

/** Throws when more than one row in the group already holds a `directus_user_id` - moving is only defined for exactly one. */
function assertAtMostOneDirectusUser(keeper: MergePerson, duplicates: readonly MergePerson[]): void {
  const holders = [keeper, ...duplicates].filter((person) => person.directus_user_id != null);
  if (holders.length > 1) {
    throw new Error(
      `Cannot merge into person ${keeper.id}: ${holders.length} rows in the group already have a directus_user_id (${holders
        .map((person) => person.id)
        .join(", ")})`,
    );
  }
}

/**
 * An ordered, explicit plan for one approved `duplicate_person` finding, following the doc's merge
 * steps: relink participants, merge medical profiles, repoint every other FK, collapse the
 * duplicates that repointing created, move a lone `directus_user_id`, fill the keeper's null
 * scalars, and delete the duplicate people last so a rerun of a partial merge still completes.
 */
export function planPersonMerge(
  keeper: MergePerson,
  duplicates: readonly MergePerson[],
  related: MergeRelatedData,
): MergeStep[] {
  assertAtMostOneDirectusUser(keeper, duplicates);
  const duplicateIds = new Set(duplicates.map((duplicate) => duplicate.id));

  const steps: MergeStep[] = [];

  for (const participant of related.participants) {
    if (participant.person_id !== null && duplicateIds.has(participant.person_id)) {
      steps.push({ type: "update", collection: "participants", id: participant.id, patch: { person_id: keeper.id } });
    }
  }

  steps.push(...planMedicalProfileMerge(keeper, related.medicalProfiles));
  steps.push(...planContactMerge(keeper.id, duplicateIds, related.contacts));
  steps.push(...planContactPointMerge(keeper.id, duplicateIds, related.contactPoints));
  steps.push(...planSimpleRepoint("program_role_assignments", keeper.id, duplicateIds, related.programRoleAssignments));
  steps.push(...planSimpleRepoint("event_staff", keeper.id, duplicateIds, related.eventStaff));

  const personPatch = buildKeeperPersonPatch(keeper, duplicates);
  if (Object.keys(personPatch).length > 0) {
    steps.push({ type: "update", collection: "people", id: keeper.id, patch: personPatch });
  }

  steps.push({ type: "delete", collection: "people", ids: [...duplicateIds] });

  return steps;
}

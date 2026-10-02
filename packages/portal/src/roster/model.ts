/**
 * Pure joins, grouping, and filtering for the roster section (#166). No fetch, no DOM — the raw
 * shapes below match exactly what the Community role's `names`/`contacts`/`family` policies return
 * (see the design doc's "Directus rules" section and `packages/infrastructure/src/crm/community-rules.ts`),
 * nothing more.
 */

/** `GET /items/registration_entries`, filtered server-side to the viewer's own teammates. */
export interface RawEntry {
  readonly id: string;
  readonly class_id: {
    readonly id: string;
    readonly name: string | null;
    readonly program_id: { readonly id: string; readonly name: string | null } | null;
  } | null;
  readonly registration_id: {
    readonly id: string;
    readonly participant_id: { readonly person_id: string | null } | null;
  } | null;
}

/** `GET /items/people`. */
export interface RawPerson {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly school?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}

/** `GET /items/registrations`. The `family` policy grants `camp_id` only on its own rows; the
 * `names` policy's read of this collection is narrower (`id, participant_id`) and never includes
 * it, so a row with a null `camp_id` came from `names`, not `family` — see `shareToggleRows`. */
export interface RawRegistration {
  readonly id: string;
  readonly camp_id: string | null;
  readonly participant_id: string;
  readonly share_contact: boolean | null;
}

/** `GET /items/participants`, fields `id, person_id` — the join from a registration to the person
 * it belongs to. */
export interface RawParticipant {
  readonly id: string;
  readonly person_id: string | null;
}

/** `GET /items/contacts`, requested with `fields=subject_id,contact_id,relationship_type` — a bare
 * guardian link, with no nested fields, so `subject_id` and `contact_id` come back as plain ids. */
export interface RawGuardianLink {
  readonly subject_id: string | null;
  readonly contact_id: string | null;
  readonly relationship_type: string | null;
}

/** A shared guardian's own contact details, joined in under the child they belong to. */
export interface GuardianContact {
  readonly personId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface TeamMember {
  readonly personId: string;
  readonly fullName: string;
  readonly school: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly programId: string;
  readonly programName: string;
  readonly teamName: string;
  readonly guardianContacts: readonly GuardianContact[];
}

/**
 * Mirrors `normalizeName` (`packages/clubspot-sync/src/people.ts`) so a school groups the same way
 * here as it does in the sync's own de-duplication. Portal has no runtime dependency on that
 * package — it ships as a bundler-free browser script, and clubspot-sync is a Node/Parse-SDK job —
 * so the handful of lines are copied rather than imported.
 */
export function normalizeSchool(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

/** Groups guardian links by the child (`subject_id`) they belong to, resolving each `contact_id`
 * against the already-fetched `people` list to pull out that guardian's name, email, and phone —
 * the `contacts` policy grants both in the same request, scoped to opted-in teammates, so this is a
 * display join, not a write target (contrast `shareToggleRows`, which the toggle writes through). */
export function guardianContactsByChild(
  links: readonly RawGuardianLink[],
  people: readonly RawPerson[],
): Map<string, GuardianContact[]> {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const byChild = new Map<string, GuardianContact[]>();

  for (const link of links) {
    if (link.relationship_type !== "guardian" || !link.subject_id || !link.contact_id) continue;
    const guardian = peopleById.get(link.contact_id);
    if (!guardian) continue;

    const fullName = [guardian.first_name, guardian.last_name].filter((part) => !!part).join(" ");
    const contact: GuardianContact = {
      personId: guardian.id,
      fullName: fullName.length > 0 ? fullName : "(name withheld)",
      email: guardian.email ?? null,
      phone: guardian.phone ?? null,
    };
    const contacts = byChild.get(link.subject_id) ?? [];
    contacts.push(contact);
    byChild.set(link.subject_id, contacts);
  }

  return byChild;
}

/** Joins entries to people into one row per (person, team). A person with no matching `people` row
 * (shouldn't happen — `names` and the entry chain are granted together) is dropped rather than
 * shown with blanks. */
export function buildRoster(
  entries: readonly RawEntry[],
  people: readonly RawPerson[],
  guardianContacts: ReadonlyMap<string, readonly GuardianContact[]> = new Map(),
): TeamMember[] {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const seen = new Set<string>();
  const members: TeamMember[] = [];

  for (const entry of entries) {
    const personId = entry.registration_id?.participant_id?.person_id;
    const classInfo = entry.class_id;
    const program = classInfo?.program_id;
    if (!personId || !classInfo || !program) continue;

    const key = `${personId}:${classInfo.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const person = peopleById.get(personId);
    if (!person) continue;

    const fullName = [person.first_name, person.last_name].filter((part) => !!part).join(" ");
    members.push({
      personId,
      fullName: fullName.length > 0 ? fullName : "(name withheld)",
      school: person.school ?? null,
      email: person.email ?? null,
      phone: person.phone ?? null,
      programId: program.id,
      programName: program.name ?? "(unnamed program)",
      teamName: classInfo.name ?? "(unnamed team)",
      guardianContacts: guardianContacts.get(personId) ?? [],
    });
  }

  return members;
}

export interface ProgramGroup {
  readonly programId: string;
  readonly programName: string;
  readonly members: readonly TeamMember[];
}

/** Groups by program only — team and school stay filters, not further grouping tiers. */
export function groupByProgram(members: readonly TeamMember[]): ProgramGroup[] {
  const byProgram = new Map<string, { programName: string; members: TeamMember[] }>();
  for (const member of members) {
    let group = byProgram.get(member.programId);
    if (!group) {
      group = { programName: member.programName, members: [] };
      byProgram.set(member.programId, group);
    }
    group.members.push(member);
  }
  return [...byProgram.entries()]
    .map(([programId, group]) => ({ programId, programName: group.programName, members: group.members }))
    .sort((a, b) => a.programName.localeCompare(b.programName));
}

export interface RosterFilter {
  readonly team: string | null;
  readonly school: string | null;
}

export const NO_FILTER: RosterFilter = { team: null, school: null };

/** The active-camp half of `entriesUrl`'s own request filter (`browser.ts`) - mirrors
 * infrastructure's `ACTIVE_CAMP` (community-rules.ts), which can't be imported across the package
 * boundary, so the two are kept in sync by hand instead. `end_date` compares at 00:00 UTC;
 * Pacific's end of that day falls up to 32h later (UTC-8), so "-36 hours" keeps the camp visible
 * all day with a few hours to spare. */
export const ACTIVE_CAMP_FILTER = {
  start_date: { _lte: "$NOW" },
  end_date: { _gte: "$NOW(-36 hours)" },
};

// The filters below mirror `ME`, `ADULT`, `GUARDIAN_OF`, `FAMILY_SELF`, and `WRITABLE` in
// `packages/infrastructure/src/crm/community-rules.ts`, which this must match, so a Staff viewer's
// request is scoped here the same way the `family` policy already scopes a Community viewer's.

const ME_FILTER = { email: { _eq: "$CURRENT_USER.email" } };

/** A null date of birth fails `_lte`, so an unknown birthdate counts as a minor with no special
 * case. Copied from community-rules.ts's `ADULT`. */
const ADULT_FILTER = { date_of_birth: { _lte: "$NOW(-18 years)" } };

const GUARDIAN_OF_FILTER = {
  my_contacts: { _and: [{ relationship_type: { _eq: "guardian" } }, { contact_id: ME_FILTER }] },
};

/** The people a signed-in viewer acts for: their own row if an adult, or a minor they're a
 * guardian contact of. */
const FAMILY_SELF_FILTER = { _or: [GUARDIAN_OF_FILTER, { _and: [ME_FILTER, ADULT_FILTER] }] };

/** `registrationsUrl`'s own request filter (browser.ts) - this season's registration for someone
 * the signed-in viewer acts for. */
export const FAMILY_REGISTRATIONS_FILTER = {
  _and: [{ camp_id: ACTIVE_CAMP_FILTER }, { participant_id: { person_id: FAMILY_SELF_FILTER } }],
};

/** The viewer's own `people.id`, when they're an adult with a row of their own (not only a
 * guardian) - used to label a toggle "your" contact info rather than a child's. */
export const VIEWER_SELF_FILTER = { _and: [ME_FILTER, ADULT_FILTER] };

export function filterMembers(members: readonly TeamMember[], filter: RosterFilter): TeamMember[] {
  return members.filter((member) => {
    if (filter.team && member.teamName !== filter.team) return false;
    if (filter.school && normalizeSchool(member.school) !== filter.school) return false;
    return true;
  });
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function teamOptions(members: readonly TeamMember[]): FilterOption[] {
  return [...new Set(members.map((member) => member.teamName))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
}

/** One option per normalized school, labeled with the first spelling seen for it. */
export function schoolOptions(members: readonly TeamMember[]): FilterOption[] {
  const labelByKey = new Map<string, string>();
  for (const member of members) {
    const key = normalizeSchool(member.school);
    if (key == null || labelByKey.has(key)) continue;
    labelByKey.set(key, (member.school ?? "").trim());
  }
  return [...labelByKey.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
}

export interface ShareToggleRow {
  readonly personId: string;
  readonly programId: string;
  readonly firstName: string;
  readonly programName: string;
  /** True when this row is the viewer's own registrations, not a child's — distinct wording (#166). */
  readonly isSelf: boolean;
  readonly checked: boolean;
  readonly registrationIds: readonly string[];
}

/** Maps a registration to the program it's entered in, through the same
 * registration_entries → class → program chain `buildRoster` joins the other direction. The first
 * entry seen for a registration wins — a season registration enters one program in practice. */
function programByRegistration(entries: readonly RawEntry[]): Map<string, { programId: string; programName: string }> {
  const map = new Map<string, { programId: string; programName: string }>();
  for (const entry of entries) {
    const registrationId = entry.registration_id?.id;
    const program = entry.class_id?.program_id;
    if (!registrationId || !program || map.has(registrationId)) continue;
    map.set(registrationId, { programId: program.id, programName: program.name ?? "(unnamed program)" });
  }
  return map;
}

/** `ShareToggleRow`, but with a mutable `registrationIds` and `checked` while `shareToggleRows`
 * accumulates a registration's siblings into it. */
interface MutableShareToggleRow {
  personId: string;
  programId: string;
  programName: string;
  firstName: string;
  isSelf: boolean;
  checked: boolean;
  registrationIds: string[];
}

/**
 * One row per (person, program) the viewer may toggle sharing for. Sharing is already program-wide
 * (docs/crm-schema.md "Community"): a person with two registrations in the same program gets one
 * row, checked when any of them has opted in, and written through every one of them. Trusts
 * `registrations` as already scoped to the viewer's family — `browser.ts`'s `registrationsUrl` sends
 * `FAMILY_REGISTRATIONS_FILTER`, so every role sees the same rows a Community viewer's `family`
 * policy would grant. A registration with a null `camp_id`, an unresolvable participant or person,
 * or no program through the entries chain is dropped.
 */
export function shareToggleRows(
  registrations: readonly RawRegistration[],
  participants: readonly RawParticipant[],
  people: readonly RawPerson[],
  entries: readonly RawEntry[],
  viewerPersonId: string | null,
): ShareToggleRow[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const personById = new Map(people.map((person) => [person.id, person]));
  const programByReg = programByRegistration(entries);
  const rows = new Map<string, MutableShareToggleRow>();

  for (const registration of registrations) {
    if (registration.camp_id == null) continue;

    const participant = participantById.get(registration.participant_id);
    const personId = participant?.person_id;
    const person = personId ? personById.get(personId) : undefined;
    if (!personId || !person) continue;

    const program = programByReg.get(registration.id);
    if (!program) continue;

    const key = `${personId}:${program.programId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        personId,
        programId: program.programId,
        programName: program.programName,
        firstName: person.first_name ?? "(name withheld)",
        isSelf: personId === viewerPersonId,
        checked: false,
        registrationIds: [],
      };
      rows.set(key, row);
    }
    row.registrationIds.push(registration.id);
    if (registration.share_contact === true) row.checked = true;
  }

  return [...rows.values()];
}

/** One registration's outcome from a share-toggle batch PATCH, independent of `fetch`/`Promise` so
 * `applyShareUpdateResults` can be tested without a DOM or a mocked `fetch`. */
export interface ShareUpdateResult {
  readonly registrationId: string;
  readonly ok: boolean;
}

/** Applies only the PATCHes that actually succeeded, so a partial batch failure (one registration
 * writes, its sibling doesn't) leaves the written one matching the server instead of reverting the
 * whole row (#166). */
export function applyShareUpdateResults(
  registrations: readonly RawRegistration[],
  results: readonly ShareUpdateResult[],
  value: boolean,
): RawRegistration[] {
  const succeeded = new Set(results.filter((result) => result.ok).map((result) => result.registrationId));
  return registrations.map((registration) =>
    succeeded.has(registration.id) ? { ...registration, share_contact: value } : registration,
  );
}

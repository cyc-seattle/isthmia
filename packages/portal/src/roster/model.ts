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

/** `GET /items/camps`, fields `id, name` — granted with no filter, since a camp's own name isn't
 * sensitive. */
export interface RawCamp {
  readonly id: string;
  readonly name: string | null;
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
 * display join, not a write target (contrast `familyIds`, which the toggle writes through). */
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
  readonly registrationId: string;
  readonly firstName: string;
  readonly campName: string;
  readonly checked: boolean;
}

/**
 * One row per registration the viewer can update, joined through `participants` and `people` to
 * the first name it's for, and through `camp_id` to the camp it runs in. A registration with a
 * null `camp_id` is dropped: it came from the `names` policy's narrower read, not from a writable
 * row, and a PATCH against it would be rejected. A registration whose participant or person can't
 * be resolved (shouldn't happen — they're granted together) is dropped the same way, rather than
 * shown with a blank name.
 */
export function shareToggleRows(
  registrations: readonly RawRegistration[],
  participants: readonly RawParticipant[],
  people: readonly RawPerson[],
  camps: readonly RawCamp[],
): ShareToggleRow[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const personById = new Map(people.map((person) => [person.id, person]));
  const campById = new Map(camps.map((camp) => [camp.id, camp]));
  const rows: ShareToggleRow[] = [];

  for (const registration of registrations) {
    if (registration.camp_id == null) continue;

    const participant = participantById.get(registration.participant_id);
    const person = participant?.person_id ? personById.get(participant.person_id) : undefined;
    const camp = campById.get(registration.camp_id);
    if (!person || !camp) continue;

    rows.push({
      registrationId: registration.id,
      firstName: person.first_name ?? "(name withheld)",
      campName: camp.name ?? "(unnamed camp)",
      checked: registration.share_contact === true,
    });
  }

  return rows;
}

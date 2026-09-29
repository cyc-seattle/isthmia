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

/**
 * `GET /items/people`. Directus includes `email`, `phone`, and `share_contact` only for rows the
 * `contacts` or `family` policy respectively grants — those keys are absent (not merely `null`) on
 * every other row, which is how `familyMembers` below tells "not permitted" apart from "permitted,
 * never answered."
 */
export interface RawPerson {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly school?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly share_contact?: boolean | null;
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

/** Joins entries to people into one row per (person, team). A person with no matching `people` row
 * (shouldn't happen — `names` and the entry chain are granted together) is dropped rather than
 * shown with blanks. */
export function buildRoster(entries: readonly RawEntry[], people: readonly RawPerson[]): TeamMember[] {
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

/** The rows the `family` policy granted — the viewer's own guardian charges, or their own adult
 * row. Detected by the `share_contact` key's presence, not its value: a permitted row that has
 * never been answered is `null`, indistinguishable in value from a row the policy masked entirely,
 * but the JSON key itself is only ever present when a policy actually granted it. */
export function familyMembers(people: readonly RawPerson[]): RawPerson[] {
  return people.filter((person) => Object.hasOwn(person, "share_contact"));
}

/** The toggle shows one shared state for the whole family: opted in if any of them are. */
export function familyOptedIn(family: readonly RawPerson[]): boolean {
  return family.some((person) => person.share_contact === true);
}

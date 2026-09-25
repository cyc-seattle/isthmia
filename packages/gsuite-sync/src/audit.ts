import { CampRow, ClassRow } from "@cyc-seattle/clubspot";
import { isValidEmail, PersonRow, ProgramRow } from "@cyc-seattle/crm";
import { AuditFindingInput } from "@cyc-seattle/directus";
import { GroupMember } from "@cyc-seattle/gsuite";
import { MembershipTables, planProgramMemberPeople, planProgramMembers } from "./membership.js";
import { planGroupNesting } from "./nesting.js";
import { planGroupOwners } from "./owners.js";
import { GoogleGroupRow, ProgramWithGoogleGroup } from "./schema.js";

/** Which sync raised a finding. `class_without_program` tags `clubspot-sync` even though this
 * pass computes it - see `findClassesWithoutProgram`. */
export const GSUITE_SYNC_SOURCE = "gsuite-sync";
export const CLUBSPOT_SYNC_SOURCE = "clubspot-sync";

export type AuditFindingKind =
  | "unexpected_member"
  | "stale_member"
  | "settings_drift"
  | "missing_group"
  | "program_without_group"
  | "class_without_program"
  | "mismatched_revenue_account"
  | "invalid_email";

/** Every kind this pass can raise. Scopes `planAuditFindingWrites` to the rows it owns, so it
 * never resolves a finding some other sync raised. */
export const AUDIT_FINDING_KINDS: readonly AuditFindingKind[] = [
  "unexpected_member",
  "stale_member",
  "settings_drift",
  "missing_group",
  "program_without_group",
  "class_without_program",
  "mismatched_revenue_account",
  "invalid_email",
];

/** An `audit_findings` input narrowed to the kinds this pass raises - `AuditFindingInput` itself
 * only knows `kind` as a plain string, since `directus` has no knowledge of any sync's kinds. */
export type GsuiteAuditFinding = AuditFindingInput & { kind: AuditFindingKind };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Group managers are managed by hand until roles have one model (#156), so neither membership
// check audits them. Owners still are: config owners are in the plan, and a stray one is worth a look.
function isAudited(member: GroupMember): boolean {
  return member.role !== "MANAGER";
}

/**
 * `unexpected_member` findings: a live member of `group` whose email isn't in `plannedEmails` -
 * the union every write pass would ever add there, ignoring the membership window (see
 * `plannedGroupMembers`'s `unwindowed` plan). Add-only means nobody already in a group is ever
 * compared against the plan until now; this is where a person who left the program, or was added
 * by hand for reasons the CRM doesn't know about, becomes visible for a human to decide about, not
 * flagged as an error. A member who aged out of the membership window but still has a real
 * registration or role is `stale_member` instead - see `findStaleMembers`.
 */
export function findUnexpectedMembers(
  group: Pick<GoogleGroupRow, "email">,
  plannedEmails: readonly string[],
  liveMembers: readonly GroupMember[],
): GsuiteAuditFinding[] {
  const planned = new Set(plannedEmails.map(normalizeEmail));
  return liveMembers
    .filter((member) => isAudited(member) && !planned.has(normalizeEmail(member.email)))
    .map((member) => ({
      source: GSUITE_SYNC_SOURCE,
      kind: "unexpected_member" as const,
      subject: group.email,
      detail: `${normalizeEmail(member.email)} is a member of ${group.email} but isn't in the plan for it`,
    }));
}

/**
 * `stale_member` findings: a live member of `group` who is in the unwindowed plan but not the
 * windowed one - a real registration or role, just one the membership window (#149) has aged past.
 * Add-only means they were added legitimately and are never removed automatically; this is what
 * keeps them from being misreported as `unexpected_member`.
 */
export function findStaleMembers(
  group: Pick<GoogleGroupRow, "email">,
  windowedEmails: readonly string[],
  unwindowedEmails: readonly string[],
  liveMembers: readonly GroupMember[],
): GsuiteAuditFinding[] {
  const windowed = new Set(windowedEmails.map(normalizeEmail));
  const unwindowed = new Set(unwindowedEmails.map(normalizeEmail));
  return liveMembers
    .filter((member) => {
      const email = normalizeEmail(member.email);
      return isAudited(member) && unwindowed.has(email) && !windowed.has(email);
    })
    .map((member) => ({
      source: GSUITE_SYNC_SOURCE,
      kind: "stale_member" as const,
      subject: group.email,
      detail: `${normalizeEmail(member.email)} is a member of ${group.email} from a past season outside the membership window`,
    }));
}

/** `missing_group` finding for a `google_groups` row whose address Workspace has no group for. */
export function findMissingGroup(group: Pick<GoogleGroupRow, "id" | "email">, exists: boolean): GsuiteAuditFinding[] {
  if (exists) {
    return [];
  }
  return [
    {
      source: GSUITE_SYNC_SOURCE,
      kind: "missing_group",
      subject: group.email,
      detail: `google_groups row ${group.id ?? "?"} references ${group.email}, which doesn't exist in Workspace`,
    },
  ];
}

/**
 * `missing_group` finding for an archived `google_groups` row a program still points at.
 * Archiving skips every other check for the row - see `runAudit` - so this is the one thing about
 * an archived row that still needs a human's attention: a program pointing at a group Workspace no
 * longer has.
 */
export function findMissingGroupForArchivedProgramGroup(
  group: Pick<GoogleGroupRow, "id" | "email">,
  isProgramGroup: boolean,
): GsuiteAuditFinding[] {
  if (!isProgramGroup) {
    return [];
  }
  return [
    {
      source: GSUITE_SYNC_SOURCE,
      kind: "missing_group",
      subject: group.email,
      detail: `google_groups row ${group.id ?? "?"} for ${group.email} is archived, but a program still references it`,
    },
  ];
}

/**
 * `program_without_group` findings: a `programs` row with no `google_group_id` set. That's the
 * only rule for whether a program gets a group, so this finding is what makes an omission visible
 * instead of silent.
 */
export function findProgramsWithoutGroup(programs: readonly ProgramWithGoogleGroup[]): GsuiteAuditFinding[] {
  return programs
    .filter((program) => program.id && !program.google_group_id)
    .map((program) => ({
      source: GSUITE_SYNC_SOURCE,
      kind: "program_without_group" as const,
      subject: program.id as string,
      detail: `Program "${program.name}" (${program.id}) has no google_group_id`,
    }));
}

/**
 * `class_without_program` findings: a `classes` row with no `program_id`, the hand-set link from
 * #149. This is a Clubspot-side gap - `program_id` lives on `classes` in `clubspot`'s own schema
 * and has nothing to do with a Google Group - so it's tagged `clubspot-sync` rather than
 * `gsuite-sync`, even though this pass is the one computing it today.
 */
export function findClassesWithoutProgram(classes: readonly ClassRow[]): GsuiteAuditFinding[] {
  return classes
    .filter((cls) => cls.id && !cls.program_id)
    .map((cls) => ({
      source: CLUBSPOT_SYNC_SOURCE,
      kind: "class_without_program" as const,
      subject: cls.id as string,
      detail: `Class "${cls.name}" (${cls.id}) has no program_id`,
    }));
}

/**
 * Everyone the membership pass would try to add right now, across every program whose group is
 * live: inside the membership window, so an old registration's bad address isn't reported.
 */
export function candidateMemberPeople(tables: AuditTables, now: Date): PersonRow[] {
  const liveGroupIds = new Set(tables.groups.filter((group) => group.id && !group.archived).map((group) => group.id));
  const people = new Map<string, PersonRow>();
  for (const program of tables.programs) {
    if (!program.id || !program.google_group_id || !liveGroupIds.has(program.google_group_id)) {
      continue;
    }
    for (const person of planProgramMemberPeople(program.id, tables, now)) {
      people.set(person.id as string, person);
    }
  }
  return [...people.values()];
}

/**
 * `invalid_email` findings: a person whose `email` isn't a usable address. Membership skips them
 * (see `isValidEmail`), so this is where they surface to be fixed. The caller passes only
 * `candidateMemberPeople`, so nobody outside a current group is reported.
 * Fix it in Directus: clubspot-sync only fills empty `people` fields (#137), so a Clubspot-only
 * correction never lands.
 */
export function findInvalidEmails(
  people: readonly Pick<PersonRow, "id" | "first_name" | "last_name" | "email">[],
): GsuiteAuditFinding[] {
  return people
    .filter((person) => person.id && person.email && person.email.trim() !== "" && !isValidEmail(person.email))
    .map((person) => ({
      source: CLUBSPOT_SYNC_SOURCE,
      kind: "invalid_email" as const,
      subject: person.id as string,
      detail: `${[person.first_name, person.last_name].filter(Boolean).join(" ") || "(no name)"} has an unusable email: "${person.email}"`,
    }));
}

/**
 * `mismatched_revenue_account` findings: a camp whose classes map to programs with more than one
 * distinct, non-null `revenue_account`. A Clubspot Camp has a single sales account
 * (`clubspot_sales_account`), so every class within it should share one. A program with a null
 * `revenue_account` isn't mapped yet and doesn't itself count as a conflict - only two or more
 * distinct values do. Tagged `clubspot-sync`, the same as `class_without_program`: this is a
 * Clubspot/finance concern, not a Google one, even though this pass computes it.
 */
export function findMismatchedRevenueAccounts(
  camps: readonly Pick<CampRow, "id" | "name" | "clubspot_sales_account">[],
  classes: readonly ClassRow[],
  programs: readonly Pick<ProgramRow, "id" | "revenue_account">[],
): GsuiteAuditFinding[] {
  const programById = new Map(
    programs.filter((program) => program.id).map((program) => [program.id as string, program]),
  );

  const findings: GsuiteAuditFinding[] = [];
  for (const camp of camps) {
    if (!camp.id) {
      continue;
    }
    const accounts = new Set<string>();
    for (const cls of classes) {
      if (cls.camp_id !== camp.id || !cls.program_id) {
        continue;
      }
      const revenueAccount = programById.get(cls.program_id)?.revenue_account;
      if (revenueAccount) {
        accounts.add(revenueAccount);
      }
    }
    if (accounts.size > 1) {
      findings.push({
        source: CLUBSPOT_SYNC_SOURCE,
        kind: "mismatched_revenue_account",
        subject: camp.id,
        detail: `Camp "${camp.name}" (${camp.id}, sales account ${camp.clubspot_sales_account ?? "none"}) has classes mapped to programs with different revenue_account values: ${[...accounts].sort().join(", ")}`,
      });
    }
  }
  return findings;
}

/** Every row the audit pass needs to compute a group's full planned membership, regardless of
 * role - the union of what every write pass would add there. `camps` and `programs` carry the
 * extra fields `findMismatchedRevenueAccounts` and the membership window need, on top of what
 * `MembershipTables` itself requires. */
export interface AuditTables extends MembershipTables {
  groups: readonly GoogleGroupRow[];
  camps: readonly CampRow[];
  programs: readonly ProgramWithGoogleGroup[];
}

/**
 * A group's planned membership under two views, both reachable from `MembershipTables`: `windowed`
 * is what a write pass would add today (participants inside the membership window, plus role
 * assignments, nested children, and owners); `unwindowed` additionally counts a class's
 * participants regardless of how long ago its camp ended. A live member in `unwindowed` but not
 * `windowed` has aged out rather than never belonged - see `findStaleMembers` vs
 * `findUnexpectedMembers`.
 */
export interface PlannedGroupMembers {
  windowed: string[];
  unwindowed: string[];
}

/**
 * Whether some program points at `group`. Gates both membership auditing - an unmapped group has
 * no plan beyond its owners, so auditing it would report every member as unexpected, including
 * parent groups like `doublehanded@` whose only planned members are nested groups - and, for an
 * archived group, whether `missing_group` is worth raising at all.
 */
export function isProgramGroup(
  group: Pick<GoogleGroupRow, "id">,
  programs: readonly Pick<ProgramWithGoogleGroup, "google_group_id">[],
): boolean {
  return group.id != null && programs.some((program) => program.google_group_id === group.id);
}

/**
 * Computes both membership views for `group`: program members (participants, guardians, and role
 * assignments - see `planProgramMembers`), nested child groups, and owners. This is deliberately
 * the union of every role - `findUnexpectedMembers`/`findStaleMembers` only care whether someone
 * belongs at all, not which role they hold.
 */
export function plannedGroupMembers(
  group: Pick<GoogleGroupRow, "id">,
  tables: AuditTables,
  now: Date,
  groupOwners: readonly string[],
): PlannedGroupMembers {
  const windowed = new Set<string>();
  const unwindowed = new Set<string>();

  for (const program of tables.programs) {
    if (!program.id || program.google_group_id !== group.id) {
      continue;
    }
    for (const email of planProgramMembers(program.id, tables, now)) {
      windowed.add(email);
      unwindowed.add(email);
    }
    for (const email of planProgramMembers(program.id, tables, now, { ignoreCampWindow: true })) {
      unwindowed.add(email);
    }
  }

  for (const { child, parent } of planGroupNesting(tables.groups)) {
    if (parent.id === group.id) {
      windowed.add(normalizeEmail(child.email));
      unwindowed.add(normalizeEmail(child.email));
    }
  }

  for (const email of planGroupOwners(groupOwners)) {
    windowed.add(email);
    unwindowed.add(email);
  }

  return { windowed: [...windowed], unwindowed: [...unwindowed] };
}

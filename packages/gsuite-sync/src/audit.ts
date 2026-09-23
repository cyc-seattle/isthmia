import { createHash } from "node:crypto";
import { AuditFindingRow } from "@cyc-seattle/directus";
import { GroupMember } from "@cyc-seattle/gsuite";
import { MembershipTables, planClassMembers } from "./membership.js";
import { planGroupNesting } from "./nesting.js";
import { planGroupOwners } from "./owners.js";
import { planProgramManagers, ProgramRoleTables } from "./roles.js";
import { ClassWithGoogleGroup, GoogleGroupRow, ProgramWithGoogleGroup } from "./schema.js";

/** Which sync raised a finding. `class_without_program` tags `clubspot-sync` even though this
 * pass computes it - see `findClassesWithoutProgram`. */
export const GSUITE_SYNC_SOURCE = "gsuite-sync";
export const CLUBSPOT_SYNC_SOURCE = "clubspot-sync";

export type AuditFindingKind =
  | "unexpected_member"
  | "settings_drift"
  | "missing_group"
  | "program_without_group"
  | "class_without_program";

/** Every kind this pass can raise. Scopes `planAuditFindingWrites` to the rows it owns, so it
 * never resolves a finding some other sync raised. */
export const AUDIT_FINDING_KINDS: readonly AuditFindingKind[] = [
  "unexpected_member",
  "settings_drift",
  "missing_group",
  "program_without_group",
  "class_without_program",
];

/** An `audit_findings` row before its `fingerprint` and `status` are attached. */
export interface AuditFindingInput {
  source: string;
  kind: AuditFindingKind;
  subject: string;
  detail: string;
}

/**
 * `source` + `kind` + `subject` + a hash of `detail`, matching the schema's unique `fingerprint`
 * column. Hashing `detail` keeps the fingerprint's length independent of how long a finding's
 * message gets, while still changing whenever the substance of the finding does - which is what
 * lets `planAuditFindingWrites` tell "already raised" from "raised again with something new to say".
 */
export function fingerprintFinding(input: AuditFindingInput): string {
  const detailHash = createHash("sha256").update(input.detail).digest("hex");
  return `${input.source}:${input.kind}:${input.subject}:${detailHash}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `unexpected_member` findings: a live member of `group` whose email isn't in `plannedEmails` -
 * the union every write pass would add there (see `plannedGroupMembers`). Add-only means nobody
 * already in a group is ever compared against the plan until now; this is where a person who left
 * the program, or was added by hand for reasons the CRM doesn't know about, becomes visible for a
 * human to decide about, not flagged as an error.
 */
export function findUnexpectedMembers(
  group: Pick<GoogleGroupRow, "email">,
  plannedEmails: readonly string[],
  liveMembers: readonly GroupMember[],
): AuditFindingInput[] {
  const planned = new Set(plannedEmails.map(normalizeEmail));
  return liveMembers
    .filter((member) => !planned.has(normalizeEmail(member.email)))
    .map((member) => ({
      source: GSUITE_SYNC_SOURCE,
      kind: "unexpected_member" as const,
      subject: group.email,
      detail: `${normalizeEmail(member.email)} is a member of ${group.email} but isn't in the plan for it`,
    }));
}

/** `missing_group` finding for a `google_groups` row whose address Workspace has no group for. */
export function findMissingGroup(group: Pick<GoogleGroupRow, "id" | "email">, exists: boolean): AuditFindingInput[] {
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
 * `program_without_group` findings: a `programs` row with no `google_group_id` set. That's the
 * only rule for whether a program gets a group, so this finding is what makes an omission visible
 * instead of silent.
 */
export function findProgramsWithoutGroup(programs: readonly ProgramWithGoogleGroup[]): AuditFindingInput[] {
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
export function findClassesWithoutProgram(classes: readonly ClassWithGoogleGroup[]): AuditFindingInput[] {
  return classes
    .filter((cls) => cls.id && !cls.program_id)
    .map((cls) => ({
      source: CLUBSPOT_SYNC_SOURCE,
      kind: "class_without_program" as const,
      subject: cls.id as string,
      detail: `Class "${cls.name}" (${cls.id}) has no program_id`,
    }));
}

/** Every row the audit pass needs to compute a group's full planned membership, regardless of
 * role - the union of what all four write passes would add there. */
export interface AuditTables extends MembershipTables, ProgramRoleTables {
  groups: readonly GoogleGroupRow[];
  classes: readonly ClassWithGoogleGroup[];
  programs: readonly ProgramWithGoogleGroup[];
}

/**
 * Every email that belongs in `group` under the current plan, across every write pass: class
 * members, nested child groups, program managers, and owners. This is deliberately the union of
 * every role - `findUnexpectedMembers` only cares whether someone belongs at all, not which role
 * they hold.
 */
export function plannedGroupMembers(
  group: Pick<GoogleGroupRow, "id">,
  tables: AuditTables,
  now: Date,
  groupOwners: readonly string[],
): string[] {
  const emails = new Set<string>();

  for (const cls of tables.classes) {
    if (cls.id && cls.google_group_id === group.id) {
      for (const email of planClassMembers(cls.id, tables)) {
        emails.add(email);
      }
    }
  }

  for (const { child, parent } of planGroupNesting(tables.groups)) {
    if (parent.id === group.id) {
      emails.add(normalizeEmail(child.email));
    }
  }

  for (const program of tables.programs) {
    if (program.id && program.google_group_id === group.id) {
      for (const assignment of planProgramManagers(program.id, tables, now)) {
        emails.add(assignment.email);
      }
    }
  }

  for (const email of planGroupOwners(groupOwners)) {
    emails.add(email);
  }

  return [...emails];
}

export interface AuditFindingWrites {
  toCreate: readonly AuditFindingInput[];
  /** Open rows to mark `resolved` - their condition wasn't raised again this run. */
  toResolve: readonly AuditFindingRow[];
  /** Resolved rows to reopen - their fingerprint recurred, so the row is reused rather than
   * colliding with a fresh insert under the unique `fingerprint` column. */
  toReopen: readonly AuditFindingRow[];
}

/**
 * Reconciles this run's findings, deduped by fingerprint, against the `audit_findings` rows this
 * pass owns (scoped by `AUDIT_FINDING_KINDS`, so a row some other sync raised is untouched). A row
 * toggles between `open` and `resolved` as its condition recurs or clears; `dismissed` rows never
 * change, since a human already reviewed them.
 */
export function planAuditFindingWrites(
  findings: readonly AuditFindingInput[],
  existingRows: readonly AuditFindingRow[],
): AuditFindingWrites {
  const freshByFingerprint = new Map<string, AuditFindingInput>();
  for (const finding of findings) {
    freshByFingerprint.set(fingerprintFinding(finding), finding);
  }

  const ownedKinds: readonly string[] = AUDIT_FINDING_KINDS;
  const ownedRows = existingRows.filter((row) => ownedKinds.includes(row.kind));
  const existingFingerprints = new Set(ownedRows.map((row) => row.fingerprint));

  const toCreate = [...freshByFingerprint.entries()]
    .filter(([fingerprint]) => !existingFingerprints.has(fingerprint))
    .map(([, finding]) => finding);

  const toResolve = ownedRows.filter((row) => row.status === "open" && !freshByFingerprint.has(row.fingerprint));
  const toReopen = ownedRows.filter((row) => row.status === "resolved" && freshByFingerprint.has(row.fingerprint));

  return { toCreate, toResolve, toReopen };
}

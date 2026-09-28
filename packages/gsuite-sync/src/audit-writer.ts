import winston from "winston";
import { ContactPointRow, ContactRow, PersonRow, ProgramRoleAssignmentRow } from "@cyc-seattle/crm";
import { CampRow, ClassRow, ParticipantRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { AuditFindingRow, DirectusClient, fingerprintFinding, planAuditFindingWrites } from "@cyc-seattle/directus";
import { Group, GroupMember } from "@cyc-seattle/gsuite";
import {
  AUDIT_FINDING_KINDS,
  AuditTables,
  candidateMemberPeople,
  findClassesWithoutProgram,
  findInvalidEmails,
  findMismatchedRevenueAccounts,
  findMissingGroup,
  findMissingGroupForArchivedProgramGroup,
  findProgramsWithoutGroup,
  findSecondaryEmailAddresses,
  findStaleMembers,
  findUnexpectedMembers,
  GsuiteAuditFinding,
  isProgramGroup,
  plannedGroupMembers,
} from "./audit.js";
import { findSettingsDrift, SettingsReader } from "./audit-settings.js";
import { GoogleGroupRow, ProgramWithGoogleGroup } from "./schema.js";

/** The slice of `DirectoryClient` the audit pass reads through - narrow enough that a real
 * instance satisfies it structurally, matching `MemberAdder`'s pattern. Reads have no side
 * effects, so unlike `MemberAdder`/`SettingsApplier` there's no dry-run variant: a `--dry-run` run
 * reads live Google state the same as a real one, and only skips the eventual write. */
export interface DirectoryReader {
  getGroup(groupKey: string): Promise<Group | null>;
  listMembers(groupKey: string): Promise<GroupMember[]>;
}

async function readAuditTables(directus: DirectusClient): Promise<AuditTables> {
  const [
    groups,
    classes,
    camps,
    programs,
    programRoleAssignments,
    people,
    contacts,
    registrationEntries,
    registrations,
    participants,
    contactPoints,
  ] = await Promise.all([
    directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
    directus.readItems<ClassRow>("classes", { limit: -1 }),
    directus.readItems<CampRow>("camps", { limit: -1 }),
    directus.readItems<ProgramWithGoogleGroup>("programs", { limit: -1 }),
    directus.readItems<ProgramRoleAssignmentRow>("program_role_assignments", { limit: -1 }),
    directus.readItems<PersonRow>("people", { limit: -1 }),
    directus.readItems<ContactRow>("contacts", { limit: -1 }),
    directus.readItems<RegistrationEntryRow>("registration_entries", { limit: -1 }),
    directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
    directus.readItems<Pick<ParticipantRow, "id" | "person_id">>("participants", {
      fields: ["id", "person_id"],
      limit: -1,
    }),
    directus.readItems<Pick<ContactPointRow, "person_id" | "kind" | "normalized">>("contact_points", {
      fields: ["person_id", "kind", "normalized"],
      limit: -1,
    }),
  ]);

  return {
    groups,
    classes,
    camps,
    programs,
    programRoleAssignments,
    people,
    contacts,
    registrationEntries,
    registrations,
    participants,
    contactPoints,
  };
}

export interface RunAuditOptions {
  directus: DirectusClient;
  directory: DirectoryReader;
  settings: SettingsReader;
  now: Date;
  groupOwners: readonly string[];
}

/**
 * The whole audit pass: compares live Google state and the canonical model against the plan, and
 * reconciles `audit_findings` with the result (see `planAuditFindingWrites`). Never removes a
 * group member or changes a setting - it only writes findings for a human to act on.
 */
export async function runAudit(options: RunAuditOptions): Promise<void> {
  const { directus, directory, settings, now, groupOwners } = options;
  const tables = await readAuditTables(directus);
  // Computed once for the whole run, not per group: `candidateMemberPeople` is the same
  // membership-window plan for every group's check.
  const candidatePeople = candidateMemberPeople(tables, now);
  const secondaryEmails = findSecondaryEmailAddresses(candidatePeople, tables.contactPoints);

  const findings: GsuiteAuditFinding[] = [
    ...findProgramsWithoutGroup(tables.programs),
    ...findClassesWithoutProgram(tables.classes),
    ...findMismatchedRevenueAccounts(tables.camps, tables.classes, tables.programs),
    ...findInvalidEmails(candidatePeople),
  ];

  for (const group of tables.groups) {
    // An archived row no longer exists in Workspace, so nothing else about it is checkable - see
    // `findMissingGroupForArchivedProgramGroup`.
    if (group.archived) {
      findings.push(...findMissingGroupForArchivedProgramGroup(group, isProgramGroup(group, tables.programs)));
      continue;
    }

    const liveGroup = await directory.getGroup(group.email);
    findings.push(...findMissingGroup(group, liveGroup !== null));
    if (!liveGroup) {
      continue;
    }

    if (isProgramGroup(group, tables.programs)) {
      const liveMembers = await directory.listMembers(group.email);
      const planned = plannedGroupMembers(group, tables, now, groupOwners);
      findings.push(...findUnexpectedMembers(group, planned.unwindowed, liveMembers, secondaryEmails));
      findings.push(...findStaleMembers(group, planned.windowed, planned.unwindowed, liveMembers));
    }

    // Isolated so the settings-drift check can be dropped, along with the settings write pass,
    // without touching the loop's other findings - see `findSettingsDrift`.
    if (group.settings_template != null) {
      const liveSettings = await settings.getSettings(group.email);
      findings.push(...findSettingsDrift(group, liveSettings));
    }
  }

  const existingRows = await directus.readItems<AuditFindingRow>("audit_findings", { limit: -1 });
  const { toCreate, toResolve, toReopen } = planAuditFindingWrites(findings, existingRows, AUDIT_FINDING_KINDS);

  for (const finding of toCreate) {
    winston.info("Raising audit finding", finding);
  }
  if (toCreate.length > 0) {
    const rows = toCreate.map(
      (finding): Omit<AuditFindingRow, "id"> => ({
        ...finding,
        status: "open",
        fingerprint: fingerprintFinding(finding),
      }),
    );
    await directus.createItems<AuditFindingRow>("audit_findings", rows as AuditFindingRow[]);
  }

  for (const row of toResolve) {
    if (row.id) {
      winston.info("Resolving audit finding", { id: row.id, kind: row.kind, subject: row.subject });
      await directus.updateItem<AuditFindingRow>("audit_findings", row.id, { status: "resolved" });
    }
  }

  for (const row of toReopen) {
    if (row.id) {
      winston.info("Reopening audit finding", { id: row.id, kind: row.kind, subject: row.subject });
      await directus.updateItem<AuditFindingRow>("audit_findings", row.id, { status: "open" });
    }
  }
}

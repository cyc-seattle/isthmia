import winston from "winston";
import { AuditFindingRow, DirectusClient } from "@cyc-seattle/directus";
import { parseDuplicatePersonFindingMemberIds } from "./audit.js";
import { readByIds } from "./directus-batch.js";
import {
  groupKey,
  HANDLED_PEOPLE_FOREIGN_KEYS,
  MERGE_PERSON_FIELDS,
  MergeContact,
  MergeContactPoint,
  MergeMedicalProfile,
  MergeParticipant,
  MergePerson,
  MergePersonReference,
  MergeRelatedData,
  MergeStep,
  planPersonMerge,
} from "./merge.js";

/**
 * The thin, impure half of "Merge, unmerge, and review" (#133): `merge.ts` plans a merge,
 * this module applies one to Directus for each `duplicate_person` finding staff have approved.
 * Runs once per sync, before the camp loop, so a merged person's records are consolidated before
 * anything else this run touches them.
 */

export interface MergeExecutorResult {
  mergesApplied: number;
  mergesSkipped: number;
}

function dedupeById<Row extends { id: string }>(rows: readonly Row[]): Row[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** Every row `planPersonMerge` needs, across the whole group - the keeper and every duplicate. */
async function readGroupRelatedData(directus: DirectusClient, personIds: readonly string[]): Promise<MergeRelatedData> {
  const [
    participants,
    contactsAsSubject,
    contactsAsContact,
    medicalProfiles,
    contactPoints,
    programRoleAssignments,
    eventStaff,
  ] = await Promise.all([
    readByIds<MergeParticipant>(directus, "participants", "person_id", personIds),
    readByIds<MergeContact>(directus, "contacts", "subject_id", personIds),
    readByIds<MergeContact>(directus, "contacts", "contact_id", personIds),
    readByIds<MergeMedicalProfile>(directus, "medical_profiles", "person_id", personIds),
    readByIds<MergeContactPoint>(directus, "contact_points", "person_id", personIds),
    readByIds<MergePersonReference>(directus, "program_role_assignments", "person_id", personIds),
    readByIds<MergePersonReference>(directus, "event_staff", "person_id", personIds),
  ]);

  return {
    participants,
    medicalProfiles,
    contacts: dedupeById([...contactsAsSubject, ...contactsAsContact]),
    contactPoints,
    programRoleAssignments,
    eventStaff,
  };
}

async function reopenFinding(directus: DirectusClient, findingId: string, message: string): Promise<void> {
  winston.warn(message, { findingId });
  await directus.updateItem<AuditFindingRow>("audit_findings", findingId, { status: "open" });
}

async function applyStep(directus: DirectusClient, step: MergeStep): Promise<void> {
  if (step.type === "update") {
    await directus.updateItem<Record<string, unknown>>(step.collection, step.id, step.patch);
    return;
  }
  for (const id of step.ids) {
    await directus.deleteItem(step.collection, id);
  }
}

/**
 * Re-reads every handled FK for each duplicate, so the final delete only ever removes a person
 * nothing points at any more - a rerun's own repoint steps are no-ops against already-merged rows,
 * but this is what actually earns the delete, not an assumption that the plan above got everything.
 */
async function findRemainingReferences(
  directus: DirectusClient,
  duplicateIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const blockedBy = new Map<string, string[]>(duplicateIds.map((id) => [id, []]));
  for (const fk of HANDLED_PEOPLE_FOREIGN_KEYS) {
    const rows = await readByIds<Record<string, unknown>>(directus, fk.collection, fk.field, duplicateIds, [fk.field]);
    for (const row of rows) {
      const referencedId = row[fk.field];
      if (typeof referencedId === "string") {
        blockedBy.get(referencedId)?.push(`${fk.collection}.${fk.field}`);
      }
    }
  }
  return blockedBy;
}

/** Deletes every duplicate with no remaining reference; reopens the finding, logging loudly, if any duplicate still has one. */
async function finalizeMerge(
  directus: DirectusClient,
  findingId: string,
  duplicateIds: readonly string[],
): Promise<"applied" | "skipped"> {
  const blockedBy = await findRemainingReferences(directus, duplicateIds);
  const blocked = duplicateIds.filter((id) => (blockedBy.get(id)?.length ?? 0) > 0);
  const clear = duplicateIds.filter((id) => !blocked.includes(id));

  for (const id of clear) {
    await directus.deleteItem("people", id);
  }

  if (blocked.length > 0) {
    winston.error("Approved person merge left a duplicate with remaining references; leaving the finding open", {
      findingId,
      blockedCount: blocked.length,
    });
    await directus.updateItem<AuditFindingRow>("audit_findings", findingId, { status: "open" });
    return "skipped";
  }

  await directus.updateItem<AuditFindingRow>("audit_findings", findingId, { status: "resolved" });
  return "applied";
}

/**
 * Applies one approved `duplicate_person` finding. Every check here is an expected condition -
 * a stale group, or two rows that both claim a `directus_user_id` - and reopens the finding rather
 * than throwing, so one bad finding doesn't stop the rest. An unexpected failure (a Directus write
 * itself failing) is not caught here: it propagates out, leaves the finding `approved`, and marks
 * the whole run failed - the next run picks the same finding back up, since `planPersonMerge` is
 * computable from partially-merged state.
 */
async function applyApprovedFinding(
  directus: DirectusClient,
  finding: AuditFindingRow,
): Promise<"applied" | "skipped"> {
  const findingId = finding.id;
  if (!findingId) {
    return "skipped";
  }

  const memberIds = parseDuplicatePersonFindingMemberIds(finding.detail);
  if (memberIds.length < 2) {
    await reopenFinding(directus, findingId, "duplicate_person finding's detail did not parse into a group of members");
    return "skipped";
  }

  const people = await readByIds<MergePerson>(directus, "people", "id", memberIds, MERGE_PERSON_FIELDS);
  if (people.length !== memberIds.length) {
    await reopenFinding(directus, findingId, "duplicate_person finding references a person row that no longer exists");
    return "skipped";
  }
  if (new Set(people.map((person) => groupKey(person))).size > 1) {
    await reopenFinding(directus, findingId, "duplicate_person finding's members no longer share a normalized name");
    return "skipped";
  }

  const keeper = people.find((person) => person.id === finding.subject);
  if (!keeper) {
    await reopenFinding(directus, findingId, "duplicate_person finding's keeper is no longer in its own group");
    return "skipped";
  }
  const duplicates = people.filter((person) => person.id !== keeper.id);

  const related = await readGroupRelatedData(directus, memberIds);

  let steps: MergeStep[];
  try {
    steps = planPersonMerge(keeper, duplicates, related);
  } catch (error) {
    await reopenFinding(
      directus,
      findingId,
      `duplicate_person finding could not be planned: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "skipped";
  }

  for (const step of steps) {
    // The final guard below is what actually earns this delete - see findRemainingReferences.
    if (step.type === "delete" && step.collection === "people") {
      continue;
    }
    await applyStep(directus, step);
  }

  return finalizeMerge(
    directus,
    findingId,
    duplicates.map((duplicate) => duplicate.id),
  );
}

/** Applies every approved `duplicate_person` finding. Called once per run, before the camp loop. */
export async function runApprovedPersonMerges(directus: DirectusClient): Promise<MergeExecutorResult> {
  const findings = await directus.readItems<AuditFindingRow>("audit_findings", {
    filter: { kind: { _eq: "duplicate_person" }, status: { _eq: "approved" } },
    limit: -1,
  });

  let mergesApplied = 0;
  let mergesSkipped = 0;
  for (const finding of findings) {
    const outcome = await applyApprovedFinding(directus, finding);
    if (outcome === "applied") {
      mergesApplied++;
    } else {
      mergesSkipped++;
    }
  }

  return { mergesApplied, mergesSkipped };
}

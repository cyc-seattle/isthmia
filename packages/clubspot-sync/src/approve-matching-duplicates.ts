import { AuditFindingRow, DirectusClient } from "@cyc-seattle/directus";
import { parseDuplicatePersonFindingMemberIds } from "./audit.js";
import { readByIds } from "./directus-batch.js";
import { groupKey, MergePerson } from "./merge.js";

/**
 * Migration step 5, run once from the CLI's `--approve-matching-duplicates` flag: approves every
 * open `duplicate_person` finding whose group's rows all share one non-null `date_of_birth` - the
 * documented participant rule (`docs/crm-schema.md`). The next normal run's merge executor is what
 * actually applies an approved finding.
 */

export type DuplicateSkipReason = "null_dob" | "differing_dob" | "missing_person";

type DuplicateCandidatePerson = Pick<MergePerson, "id" | "first_name" | "last_name" | "date_of_birth">;

export interface DuplicateApproval {
  finding: AuditFindingRow;
  /** The normalized name shared by the group (`merge.ts`'s `groupKey`) - nothing more personal, for logging. */
  name: string;
  groupSize: number;
}

export interface DuplicateSkip {
  finding: AuditFindingRow;
  reason: DuplicateSkipReason;
}

export interface DuplicateSelection {
  toApprove: readonly DuplicateApproval[];
  leftOpen: readonly DuplicateSkip[];
}

/**
 * Selects which open `duplicate_person` findings to approve. Re-reads each group's own DOB from
 * `peopleById` rather than trusting `detail`'s text, since a person's DOB can be edited after the
 * finding was raised. A finding that isn't an open `duplicate_person`, or whose group can't be
 * fully resolved against `peopleById`, is left open rather than guessed at.
 */
export function selectMatchingDuplicateFindings(
  findings: readonly AuditFindingRow[],
  peopleById: ReadonlyMap<string, DuplicateCandidatePerson>,
): DuplicateSelection {
  const toApprove: DuplicateApproval[] = [];
  const leftOpen: DuplicateSkip[] = [];

  for (const finding of findings) {
    if (finding.kind !== "duplicate_person" || finding.status !== "open") {
      continue;
    }

    const memberIds = parseDuplicatePersonFindingMemberIds(finding.detail);
    const members: DuplicateCandidatePerson[] = [];
    for (const id of memberIds) {
      const person = peopleById.get(id);
      if (!person) {
        break;
      }
      members.push(person);
    }
    if (members.length !== memberIds.length) {
      leftOpen.push({ finding, reason: "missing_person" });
      continue;
    }

    if (members.some((member) => member.date_of_birth == null)) {
      leftOpen.push({ finding, reason: "null_dob" });
      continue;
    }
    if (new Set(members.map((member) => member.date_of_birth)).size > 1) {
      leftOpen.push({ finding, reason: "differing_dob" });
      continue;
    }

    const keeper = members.find((member) => member.id === finding.subject);
    if (!keeper) {
      leftOpen.push({ finding, reason: "missing_person" });
      continue;
    }
    toApprove.push({ finding, name: groupKey(keeper) ?? finding.subject, groupSize: members.length });
  }

  return { toApprove, leftOpen };
}

export interface ApproveMatchingDuplicatesResult {
  /** Findings the rule matched - approved for real, or would be approved under `--dry-run`. */
  matching: number;
  leftOpen: Record<DuplicateSkipReason, number>;
}

function countLeftOpen(leftOpen: readonly DuplicateSkip[]): Record<DuplicateSkipReason, number> {
  return {
    null_dob: leftOpen.filter((skip) => skip.reason === "null_dob").length,
    differing_dob: leftOpen.filter((skip) => skip.reason === "differing_dob").length,
    missing_person: leftOpen.filter((skip) => skip.reason === "missing_person").length,
  };
}

/**
 * Reads every open `duplicate_person` finding and approves those `selectMatchingDuplicateFindings`
 * selects. `dryRun` writes nothing - the caller logs one line per would-approve finding from the
 * returned selection before summarizing.
 */
export async function approveMatchingDuplicates(
  directus: DirectusClient,
  dryRun: boolean,
): Promise<{ result: ApproveMatchingDuplicatesResult; selection: DuplicateSelection }> {
  const findings = await directus.readItems<AuditFindingRow>("audit_findings", {
    filter: { kind: { _eq: "duplicate_person" }, status: { _eq: "open" } },
    limit: -1,
  });

  const memberIds = [...new Set(findings.flatMap((finding) => parseDuplicatePersonFindingMemberIds(finding.detail)))];
  const people = await readByIds<DuplicateCandidatePerson>(directus, "people", "id", memberIds, [
    "id",
    "first_name",
    "last_name",
    "date_of_birth",
  ]);
  const peopleById = new Map(people.map((person) => [person.id, person]));

  const selection = selectMatchingDuplicateFindings(findings, peopleById);

  if (!dryRun) {
    for (const approval of selection.toApprove) {
      if (approval.finding.id) {
        await directus.updateItem<AuditFindingRow>("audit_findings", approval.finding.id, { status: "approved" });
      }
    }
  }

  return {
    result: { matching: selection.toApprove.length, leftOpen: countLeftOpen(selection.leftOpen) },
    selection,
  };
}

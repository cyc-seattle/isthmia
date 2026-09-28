import { ParticipantRow } from "@cyc-seattle/clubspot";
import { AuditFindingInput } from "@cyc-seattle/directus";
import { DuplicatePersonGroup, MergePerson } from "./merge.js";

/** The two kinds this run-level detection pass raises (design doc "Merge, unmerge, and review",
 * #133). Scopes `planAuditFindingWrites` to the rows it owns, so it never resolves a finding some
 * other sync raised - `class_without_program`, also tagged `source: "clubspot-sync"`, is owned and
 * reconciled by gsuite-sync's own audit pass instead. */
export type AuditFindingKind = "duplicate_person" | "unlinked_participant";

export const AUDIT_FINDING_KINDS: readonly AuditFindingKind[] = ["duplicate_person", "unlinked_participant"];

export type ClubspotSyncAuditFinding = AuditFindingInput & { kind: AuditFindingKind };

const SOURCE = "clubspot-sync";

/**
 * `duplicate_person` findings: one per `findDuplicatePeople` group, `subject` set to its proposed
 * keeper so an approved merge resolves the same finding it was raised from. `detail` carries the
 * keeper's name and each member's id and date of birth only - no email or phone - and is stable
 * across runs since `group.members` is already sorted by id.
 */
export function findDuplicatePersonFindings(
  groups: readonly DuplicatePersonGroup[],
  people: readonly Pick<MergePerson, "id" | "first_name" | "last_name">[],
): ClubspotSyncAuditFinding[] {
  const nameById = new Map(
    people.map((person) => [person.id, `${person.first_name} ${person.last_name ?? ""}`.trim()]),
  );
  return groups.map((group) => {
    const name = nameById.get(group.keeperId) ?? group.keeperId;
    const members = group.members.map((member) => `${member.id} (dob ${member.date_of_birth ?? "unknown"})`);
    return {
      source: SOURCE,
      kind: "duplicate_person" as const,
      subject: group.keeperId,
      detail: `${name}: ${members.join(", ")}`,
    };
  });
}

/**
 * The inverse of `findDuplicatePersonFindings`'s `detail` format: every member id it listed,
 * keeper included. The merge executor uses this to re-read a group's rows from an approved
 * finding, since `detail` - not a structured field - is the only place the group's membership
 * is recorded.
 */
export function parseDuplicatePersonFindingMemberIds(detail: string): string[] {
  return [...detail.matchAll(/(\S+) \(dob [^)]*\)/g)].map((match) => match[1]!);
}

/**
 * `unlinked_participant` findings: a `participants` row `person-sync.ts`'s matcher never linked
 * to a person. `detail` carries only the participant's id and name.
 */
export function findUnlinkedParticipantFindings(
  participants: readonly Pick<ParticipantRow, "id" | "person_id" | "first_name" | "last_name">[],
): ClubspotSyncAuditFinding[] {
  return participants
    .filter((participant) => participant.person_id === null)
    .map((participant) => {
      const name = `${participant.first_name ?? ""} ${participant.last_name ?? ""}`.trim();
      return {
        source: SOURCE,
        kind: "unlinked_participant" as const,
        subject: participant.id,
        detail: name.length > 0 ? `${participant.id} (${name})` : participant.id,
      };
    });
}

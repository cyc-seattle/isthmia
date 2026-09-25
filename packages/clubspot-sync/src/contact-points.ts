import winston from "winston";
import { ContactPointKind, PersonRow } from "@cyc-seattle/crm";
import { ContactPointWithParticipant } from "@cyc-seattle/clubspot";
import { DirectusClient } from "@cyc-seattle/directus";
import { normalizeEmail, normalizePhone } from "./people.js";

/**
 * `contact_points` records every email and phone a form has given for a person, not only the
 * primary on `people`, so a matcher search or a merge has more than one value to work with. The
 * sync upserts on (`person_id`, `kind`, `normalized`) - Directus can't enforce that as a composite
 * unique key, so both the planner below and the batch it's given have to dedupe on it themselves.
 */

/** One value a form gave for one person - the participant's own slot, or a guardian/emergency slot's. */
export interface ContactPointSlot {
  personId: string | null;
  email: string | null;
  phone: string | null;
}

export interface ContactPointCandidate {
  personId: string;
  kind: ContactPointKind;
  value: string;
}

export interface ContactPointCandidateWithParticipant extends ContactPointCandidate {
  participantId: string;
}

/**
 * Same rule `isValidEmail` in gsuite-sync's membership.ts applies. Duplicated rather than shared -
 * clubspot-sync and gsuite-sync are siblings in the dependency graph, and neither may import the
 * other.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.trim()) && !value.includes("..");
}

/** Flattens the participant's own slot and every guardian/emergency slot into one candidate list, dropping empty values. */
export function contactPointCandidatesFromSlots(slots: readonly ContactPointSlot[]): ContactPointCandidate[] {
  const candidates: ContactPointCandidate[] = [];
  for (const slot of slots) {
    if (!slot.personId) {
      continue;
    }
    if (slot.email) {
      candidates.push({ personId: slot.personId, kind: "email", value: slot.email });
    }
    if (slot.phone) {
      candidates.push({ personId: slot.personId, kind: "phone", value: slot.phone });
    }
  }
  return candidates;
}

function normalizeCandidateValue(kind: ContactPointKind, value: string): string | null {
  return kind === "email" ? normalizeEmail(value) : normalizePhone(value);
}

function contactPointKey(personId: string, kind: ContactPointKind, normalized: string): string {
  return `${personId}:${kind}:${normalized}`;
}

export interface ContactPointPlan {
  toCreate: Omit<ContactPointWithParticipant, "id">[];
  toUpdate: { id: string; patch: Partial<ContactPointWithParticipant> }[];
  skipped: number;
}

/**
 * Upserts on (`person_id`, `kind`, `normalized`): a value already on file only ever gets its
 * `last_seen_at` and `participant_id` touched, never its `value` or `source` - that keeps a
 * staff-added point from being silently reclaimed as `form`. Two candidates that land on the same
 * key within one batch collapse into a single write, since Directus can't reject the duplicate
 * itself; the later candidate wins.
 */
export function planContactPointUpserts(
  candidates: readonly ContactPointCandidateWithParticipant[],
  existing: readonly ContactPointWithParticipant[],
  now: Date,
): ContactPointPlan {
  const nowIso = now.toISOString();
  const existingByKey = new Map(
    existing
      .filter((row): row is ContactPointWithParticipant & { id: string } => Boolean(row.id))
      .map((row) => [contactPointKey(row.person_id, row.kind, row.normalized), row] as const),
  );

  const toCreate = new Map<string, Omit<ContactPointWithParticipant, "id">>();
  const toUpdate = new Map<string, { id: string; patch: Partial<ContactPointWithParticipant> }>();
  let skipped = 0;

  for (const candidate of candidates) {
    if (candidate.kind === "email" && !isPlausibleEmail(candidate.value)) {
      skipped++;
      continue;
    }
    const normalized = normalizeCandidateValue(candidate.kind, candidate.value);
    if (!normalized) {
      skipped++;
      continue;
    }

    const key = contactPointKey(candidate.personId, candidate.kind, normalized);
    const existingRow = existingByKey.get(key);
    if (existingRow) {
      toUpdate.set(key, {
        id: existingRow.id,
        patch: { last_seen_at: nowIso, participant_id: candidate.participantId },
      });
      continue;
    }

    toCreate.set(key, {
      person_id: candidate.personId,
      kind: candidate.kind,
      value: candidate.value,
      normalized,
      source: "form",
      last_seen_at: nowIso,
      participant_id: candidate.participantId,
    });
  }

  if (skipped > 0) {
    winston.warn(`Skipped ${skipped} contact point value(s) that failed to normalize or validate`);
  }

  return { toCreate: [...toCreate.values()], toUpdate: [...toUpdate.values()], skipped };
}

/** Every `contact_points` row for the given people, in one request. */
export async function readContactPointsForPersons(
  directus: DirectusClient,
  personIds: readonly string[],
): Promise<ContactPointWithParticipant[]> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) {
    return [];
  }
  return directus.readItems<ContactPointWithParticipant>("contact_points", {
    filter: { person_id: { _in: ids.join(",") } },
    limit: -1,
  });
}

export interface ContactPointApplyCounts {
  created: number;
  touched: number;
}

/** Writes a plan: every create in one batch, every update as its own patch. */
export async function applyContactPointPlan(
  directus: DirectusClient,
  plan: ContactPointPlan,
): Promise<ContactPointApplyCounts> {
  if (plan.toCreate.length > 0) {
    await directus.createItems<ContactPointWithParticipant>("contact_points", plan.toCreate);
  }
  for (const update of plan.toUpdate) {
    await directus.updateItem<ContactPointWithParticipant>("contact_points", update.id, update.patch);
  }
  return { created: plan.toCreate.length, touched: plan.toUpdate.length };
}

/**
 * The end-to-end upsert for one participant's worth of candidates: one read of the relevant
 * people's contact points, not one per value, then the plan and its write. A no-op - no read, no
 * write - when the form gave nothing worth recording.
 */
export async function upsertContactPoints(
  directus: DirectusClient,
  candidates: readonly ContactPointCandidateWithParticipant[],
  now: Date,
): Promise<ContactPointApplyCounts> {
  if (candidates.length === 0) {
    return { created: 0, touched: 0 };
  }
  const existing = await readContactPointsForPersons(
    directus,
    candidates.map((candidate) => candidate.personId),
  );
  const plan = planContactPointUpserts(candidates, existing, now);
  return applyContactPointPlan(directus, plan);
}

/** The (`person_id`, `kind`, `normalized`) keys already on file, for the seeder's gap-fill pass below. */
export function contactPointKeySet(rows: readonly ContactPointWithParticipant[]): Set<string> {
  return new Set(rows.map((row) => contactPointKey(row.person_id, row.kind, row.normalized)));
}

/**
 * Migration step 4's second pass: a `staff` row for any `people.email`/`people.phone` that no
 * form's contact point already covers - the primary is always in the list this way, even for a
 * person no participant, guardian, or emergency-contact slot ever resolved to.
 */
export function planStaffContactPoints(
  people: readonly Pick<PersonRow, "id" | "email" | "phone">[],
  existingKeys: ReadonlySet<string>,
  now: Date,
): Omit<ContactPointWithParticipant, "id">[] {
  const nowIso = now.toISOString();
  const rows: Omit<ContactPointWithParticipant, "id">[] = [];
  const seen = new Set<string>();

  for (const person of people) {
    if (!person.id) {
      continue;
    }
    const values: [ContactPointKind, string | null][] = [
      ["email", person.email],
      ["phone", person.phone],
    ];
    for (const [kind, raw] of values) {
      if (!raw) {
        continue;
      }
      const normalized = normalizeCandidateValue(kind, raw);
      if (!normalized) {
        continue;
      }
      const key = contactPointKey(person.id, kind, normalized);
      if (existingKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        person_id: person.id,
        kind,
        value: raw,
        normalized,
        source: "staff",
        last_seen_at: nowIso,
        participant_id: null,
      });
    }
  }

  return rows;
}

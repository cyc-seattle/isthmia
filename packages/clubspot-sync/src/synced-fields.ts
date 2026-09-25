import { RegistrationRow } from "@cyc-seattle/clubspot";
import { compareByRegistrationRecency } from "./promoted-fields.js";

/**
 * The one rule every curated CRM field follows (#137): `people` (the participant's own row and
 * every guardian/emergency-contact slot's), `medical_profiles`, and the primary email and phone
 * are all synced the same way. Pure; `person-sync.ts` is the thin, impure executor that reads
 * `base`/`v` off the mirror and writes the result.
 */

export type SyncedFieldValue = string | number | null;

export type SyncedFieldOutcome<T extends SyncedFieldValue> =
  | { action: "write"; value: T; replacedStaffEdit: boolean }
  | { action: "skip"; reason: "blank" | "unchanged" | "already-set" };

/**
 * `current` is the CRM value on file today; `base` is what the mirror held last time (`undefined`
 * for a participant whose mirror has never been written before - not the same as `null`, which
 * means the mirror existed and this field was blank); `v` is what Clubspot sends now.
 *
 * - `v` is `null`: never written, for any field - a blank never overrides anything.
 * - No prior mirror (`base` is `undefined`): fills a null CRM column only, and never counts as
 *   replacing a staff edit - there's no prior form answer to compare against yet.
 * - `v` equals `base`: no write - Clubspot repeating itself never overrides a staff edit.
 * - `v` differs from `base`: write `v`. If `current` was neither `base` nor null, a staff edit is
 *   being replaced.
 */
export function planSyncedField<T extends SyncedFieldValue>(
  current: T | null,
  base: T | null | undefined,
  v: T | null,
): SyncedFieldOutcome<T> {
  if (v === null) {
    return { action: "skip", reason: "blank" };
  }
  if (base === undefined) {
    return current === null
      ? { action: "write", value: v, replacedStaffEdit: false }
      : { action: "skip", reason: "already-set" };
  }
  if (v === base) {
    return { action: "skip", reason: "unchanged" };
  }
  return { action: "write", value: v, replacedStaffEdit: current !== null && current !== base };
}

export interface FieldTally {
  written: number;
  replacedStaffEdits: number;
  blankSkipped: number;
  /** Field names only, for the caller to log alongside a person id - never the values themselves. */
  replacedFields: string[];
}

export function emptyFieldTally(): FieldTally {
  return { written: 0, replacedStaffEdits: 0, blankSkipped: 0, replacedFields: [] };
}

export function addFieldTally(a: FieldTally, b: FieldTally): FieldTally {
  return {
    written: a.written + b.written,
    replacedStaffEdits: a.replacedStaffEdits + b.replacedStaffEdits,
    blankSkipped: a.blankSkipped + b.blankSkipped,
    replacedFields: [...a.replacedFields, ...b.replacedFields],
  };
}

export interface SyncedFieldsPlan<Row> extends FieldTally {
  patch: Partial<Row>;
}

/** One row's worth of `base`/`v` values - nullable regardless of whether `Row`'s own column is NOT NULL, since a mirror field starts out unset. */
type FieldValues<Row> = Partial<Record<keyof Row, SyncedFieldValue>>;

/**
 * Applies {@link planSyncedField} across every curated field of one row - `people` (the
 * participant's own or a guardian/emergency contact's slot) or `medical_profiles`. `Row`'s
 * concrete interfaces have no index signature of their own, same as `schedule.ts`'s `diffFields`,
 * so the cast to a plain record is internal rather than pushed onto every caller.
 */
export function planSyncedFields<Row extends { id?: string }>(
  fields: readonly (keyof Row & string)[],
  current: Partial<Row>,
  base: FieldValues<Row> | undefined,
  v: FieldValues<Row>,
): SyncedFieldsPlan<Row> {
  const currentFields = current as Record<string, SyncedFieldValue>;
  const baseFields = base as Record<string, SyncedFieldValue> | undefined;
  const vFields = v as Record<string, SyncedFieldValue>;

  const patch: Partial<Row> = {};
  const tally = emptyFieldTally();

  for (const field of fields) {
    const outcome = planSyncedField(
      currentFields[field] ?? null,
      baseFields === undefined ? undefined : (baseFields[field] ?? null),
      vFields[field] ?? null,
    );
    if (outcome.action === "write") {
      patch[field] = outcome.value as Row[typeof field];
      tally.written++;
      if (outcome.replacedStaffEdit) {
        tally.replacedStaffEdits++;
        tally.replacedFields.push(field);
      }
    } else if (outcome.reason === "blank") {
      tally.blankSkipped++;
    }
  }

  return { patch, ...tally };
}

export type RegistrationRank = Pick<RegistrationRow, "id" | "archived" | "registered_at">;

/**
 * True when `self` ranks first among every registration linked to the same person - the
 * newest-linked-participant order `docs/crm-schema.md` documents: non-archived first, then
 * `registered_at` descending, then `id` as a tiebreak. An older participant's form must never
 * overwrite a newer one's, so only this registration's sync is allowed to touch the person's
 * curated fields.
 */
export function isNewestParticipant(self: RegistrationRank, others: readonly RegistrationRank[]): boolean {
  return others.every((other) => compareByRegistrationRecency(self, other) < 0);
}

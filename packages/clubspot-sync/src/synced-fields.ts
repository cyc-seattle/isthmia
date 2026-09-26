import { RegistrationRow } from "@cyc-seattle/clubspot";
import { compareByRegistrationRecency } from "./promoted-fields.js";

/**
 * The one rule every curated CRM field follows (#137): `people` (the participant's own row and
 * every guardian/emergency-contact slot's), `medical_profiles`, and the primary email and phone
 * are all synced the same way. Pure; `person-sync.ts` is the thin, impure executor that resolves
 * `base`/`v` (via {@link resolveBase}, falling back to the person's previous newest linked
 * participant) and writes the result.
 */

export type SyncedFieldValue = string | number | null;

export type SyncedFieldOutcome<T extends SyncedFieldValue> =
  | { action: "write"; value: T; replacedStaffEdit: boolean }
  | { action: "skip"; reason: "blank" | "unchanged" | "already-set" };

/**
 * `current` is the CRM value on file today; `base` is what Clubspot is known to have sent last
 * time (`undefined` when there's no such value on record - not the same as `null`, which means a
 * mirror exists and is blank; see {@link resolveBase} for how a caller arrives at this); `v` is
 * what Clubspot sends now.
 *
 * - `v` is `null`: never written, for any field - a blank never overrides anything.
 * - No known base (`base` is `undefined`): fills a null CRM column only, and never counts as
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

/**
 * Resolves the base one field actually compares against (#137): this participant's own last known
 * value (`own`) wins whenever it's on record; a missing or blank `own` - no mirror yet, or a
 * mirror that's gone blank since - falls back to the person's previous newest linked participant's
 * value (`fallback`). With neither, there's no known base at all, so the field falls to
 * {@link planSyncedField}'s fill-null-only rule.
 *
 * This is also what makes the "A, staff S, blank, A" case hold: once `own` goes blank, it can't
 * tell a genuinely new "A" apart from Clubspot simply repeating the old one - but with no sibling
 * participant to fall back to either, there's no base to compare against, so `planSyncedField`
 * treats the returning "A" as fill-null-only and leaves the staff edit alone.
 */
export function resolveBase<T extends SyncedFieldValue>(
  own: T | null | undefined,
  fallback: T | null | undefined,
): T | null | undefined {
  if (own !== undefined && own !== null) {
    return own;
  }
  if (fallback !== undefined && fallback !== null) {
    return fallback;
  }
  return undefined;
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
export type FieldValues<Row> = Partial<Record<keyof Row, SyncedFieldValue>>;

/**
 * The row-level counterpart to {@link resolveBase}: merges a participant's own stored base with
 * the fallback sourced from the person's previous newest linked participant, one field at a time.
 * A field present in neither carries no base at all into {@link planSyncedFields} below, same as
 * passing `undefined` for the whole row.
 */
export function resolveFieldBase<Row>(
  own: FieldValues<Row> | undefined,
  fallback: FieldValues<Row> | undefined,
): FieldValues<Row> {
  const ownFields = own as Record<string, SyncedFieldValue> | undefined;
  const fallbackFields = fallback as Record<string, SyncedFieldValue> | undefined;

  const merged: Record<string, SyncedFieldValue> = {};
  for (const field of new Set([...Object.keys(ownFields ?? {}), ...Object.keys(fallbackFields ?? {})])) {
    const resolved = resolveBase(ownFields?.[field] ?? null, fallbackFields?.[field] ?? null);
    if (resolved !== undefined) {
      merged[field] = resolved;
    }
  }
  return merged as FieldValues<Row>;
}

/**
 * Applies {@link planSyncedField} across every curated field of one row - `people` (the
 * participant's own or a guardian/emergency contact's slot) or `medical_profiles`. `Row`'s
 * concrete interfaces have no index signature of their own, same as `schedule.ts`'s `diffFields`,
 * so the cast to a plain record is internal rather than pushed onto every caller. A field absent
 * from `base` - whether `base` itself is `undefined`, or `resolveFieldBase` left the key out -
 * carries no base of its own, same as the whole-row `undefined` case.
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
      baseFields === undefined ? undefined : field in baseFields ? (baseFields[field] ?? null) : undefined,
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

/** A ranking candidate carrying whatever payload the caller needs once it wins - see {@link bestRanked}. */
export interface Ranked<T> extends RegistrationRank {
  data: T;
}

/**
 * The best-ranked (see {@link isNewestParticipant}) of a list of candidates - the "previous
 * newest linked participant" #137's fallback-base rule draws a field's value from, when the
 * current participant has none of its own. `undefined` with an empty list.
 */
export function bestRanked<T>(candidates: readonly Ranked<T>[]): Ranked<T> | undefined {
  return candidates.reduce<Ranked<T> | undefined>(
    (best, candidate) => (!best || compareByRegistrationRecency(candidate, best) < 0 ? candidate : best),
    undefined,
  );
}

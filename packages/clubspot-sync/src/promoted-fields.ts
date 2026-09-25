import winston from "winston";
import { PersonRow } from "@cyc-seattle/crm";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  PROMOTABLE_PERSON_FIELDS,
  PromotablePersonField,
  PromotedFieldRow,
  RegistrationRow,
} from "@cyc-seattle/clubspot";
import { normalizeName } from "./people.js";
import { CustomFieldResponseInput } from "./registrations.js";
import { emptyFieldTally, FieldTally, planSyncedField } from "./synced-fields.js";

/**
 * Copies a staff-configured set of custom field responses onto `people` columns, so a question
 * asked on every camp (e.g. "School") becomes a column instead of a three-table join.
 *
 * Two paths write it, both pure, and both following the one CRM field rule (#137):
 * - `planPromotedFieldSync` runs once per registration, inside `syncRegistrations`
 *   (`sync-run.ts`), gated on the same newest-linked-participant check `people` and
 *   `medical_profiles` use. `custom_field_responses` is itself the mirror here: `base` is what
 *   the response row held before this run's write, `v` is what Clubspot sends now - so a changed
 *   answer replaces a stale one (and counts as a replaced staff edit if the CRM value was neither),
 *   and a blank is never written.
 * - `planPromotedFields` runs once at the end of every run, across every camp, as a fallback: it
 *   only fills a column that's still null, for a registration the per-registration path didn't
 *   reach this run - one outside every camp's watermark, say. There's no single registration's
 *   `base` to compare here, only the best-ranked response across every camp, so it stays
 *   gap-fill-only.
 */
export interface PersonPatch {
  id: string;
  patch: Partial<PersonRow>;
}

// `custom_field_responses.field_type` values that hold a plain string worth promoting - a
// file_upload response isn't a scalar.
const SCALAR_FIELD_TYPES = new Set(["text", "select", "radio"]);

function isPromotableField(value: string): value is PromotablePersonField {
  return (PROMOTABLE_PERSON_FIELDS as readonly string[]).includes(value);
}

/** `custom_field_responses.value` is nullable, and both null and "" mean "left blank". */
function trimmedValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

type DefinitionWithId = CustomFieldDefinitionRow & { id: string };

/**
 * Maps each scalar-typed definition to the target column it promotes to, by matching its
 * normalized label against the configured labels. A configured label matching no definition at
 * all warns once per run, naming the label - it's a typo or a question no camp asks any more. A
 * config row naming a target outside `PROMOTABLE_PERSON_FIELDS` also warns and is skipped, rather
 * than written by string.
 */
export function buildTargetByDefinitionId(
  promotedFields: readonly PromotedFieldRow[],
  definitions: readonly CustomFieldDefinitionRow[],
): Map<string, PromotablePersonField> {
  const definitionsByNormalizedLabel = new Map<string, DefinitionWithId[]>();
  for (const definition of definitions) {
    if (!definition.id) {
      continue;
    }
    const normalized = normalizeName(definition.label);
    if (!normalized) {
      continue;
    }
    const group = definitionsByNormalizedLabel.get(normalized) ?? [];
    group.push(definition as DefinitionWithId);
    definitionsByNormalizedLabel.set(normalized, group);
  }

  const targetByDefinitionId = new Map<string, PromotablePersonField>();
  const warnedLabels = new Set<string>();

  for (const config of promotedFields) {
    if (!isPromotableField(config.target_field)) {
      winston.warn(`promoted_fields row targets "${config.target_field}", which isn't a promotable people column`, {
        targetField: config.target_field,
      });
      continue;
    }

    for (const label of config.labels) {
      const normalized = normalizeName(label);
      const matches = normalized ? definitionsByNormalizedLabel.get(normalized) : undefined;
      if (!matches) {
        if (!warnedLabels.has(label)) {
          warnedLabels.add(label);
          winston.warn(`Configured label "${label}" matches no custom field definition`, { label });
        }
        continue;
      }
      for (const definition of matches) {
        if (SCALAR_FIELD_TYPES.has(definition.field_type)) {
          targetByDefinitionId.set(definition.id, config.target_field);
        }
      }
    }
  }

  return targetByDefinitionId;
}

/**
 * Ranks two registrations by recency: non-archived before archived, then most recently
 * registered, then `id` descending as a stable tiebreak - a comparator that could flap would
 * write a Directus revision every hour. Archived ranks last rather than being excluded, so a
 * cancelled registration's answer can still fill a column nothing else answers.
 *
 * Shared with `synced-fields.ts`'s newest-linked-participant rule (#137), which uses the same
 * order to decide whose form answer wins a person's curated fields.
 */
export function compareByRegistrationRecency(
  a: Pick<RegistrationRow, "id" | "archived" | "registered_at">,
  b: Pick<RegistrationRow, "id" | "archived" | "registered_at">,
): number {
  if (a.archived !== b.archived) {
    return a.archived ? 1 : -1;
  }
  if (a.registered_at !== b.registered_at) {
    return a.registered_at > b.registered_at ? -1 : 1;
  }
  return a.id > b.id ? -1 : 1;
}

export interface PromotedFieldSyncPlan extends FieldTally {
  patch: Partial<Record<PromotablePersonField, string>>;
}

/**
 * Applies the one CRM field rule (#137) to one registration's promotable responses. `response` is
 * this registration's own raw `customFieldsArray`; `existingResponses` is its own
 * `custom_field_responses` rows as stored before this run's write - the `base` side of the rule,
 * same as `participants` is for every other curated field. `currentPerson` is the resolved
 * person's current value for every promotable column.
 *
 * The caller gates this on the newest-linked-participant check - an older registration's answer
 * must never overwrite a newer one's, same as any other curated field.
 */
export function planPromotedFieldSync(
  targetByDefinitionId: ReadonlyMap<string, PromotablePersonField>,
  responses: readonly CustomFieldResponseInput[],
  existingResponses: readonly CustomFieldResponseRow[],
  currentPerson: Partial<Record<PromotablePersonField, string | null>>,
): PromotedFieldSyncPlan {
  const existingByDefinitionId = new Map(existingResponses.map((row) => [row.definition_id, row] as const));

  const patch: Partial<Record<PromotablePersonField, string>> = {};
  const tally = emptyFieldTally();

  for (const response of responses) {
    const targetField = targetByDefinitionId.get(response.customFieldID);
    if (!targetField) {
      continue;
    }
    const existing = existingByDefinitionId.get(response.customFieldID);
    const base = existing ? trimmedValue(existing.value) : undefined;
    const v = trimmedValue(response.response ?? null);
    const current = currentPerson[targetField] ?? null;

    const outcome = planSyncedField(current, base, v);
    if (outcome.action === "write") {
      patch[targetField] = outcome.value;
      tally.written++;
      if (outcome.replacedStaffEdit) {
        tally.replacedStaffEdits++;
        tally.replacedFields.push(targetField);
      }
    } else if (outcome.reason === "blank") {
      tally.blankSkipped++;
    }
  }

  return { patch, ...tally };
}

/**
 * Plans the `people` patches for one run of the promotion pass. Takes every input as CRM rows -
 * `promoted_fields`, `custom_field_definitions`, `custom_field_responses`, `registrations`, and
 * the current `people` rows - and returns only the ids whose column is currently empty and has a
 * winning response to fill it. An empty `promoted_fields` does nothing, logged at info so "not
 * seeded yet" doesn't look like a bug.
 */
export function planPromotedFields(
  promotedFields: readonly PromotedFieldRow[],
  definitions: readonly CustomFieldDefinitionRow[],
  responses: readonly CustomFieldResponseRow[],
  registrations: readonly RegistrationRow[],
  people: readonly PersonRow[],
): PersonPatch[] {
  if (promotedFields.length === 0) {
    winston.info("No promoted_fields configured; skipping the promotion pass");
    return [];
  }

  const targetByDefinitionId = buildTargetByDefinitionId(promotedFields, definitions);

  const registrationsById = new Map<string, RegistrationRow>();
  for (const registration of registrations) {
    registrationsById.set(registration.id, registration);
  }

  // The current best response per person, per target field.
  const winnersByPerson = new Map<
    string,
    Map<PromotablePersonField, { registration: RegistrationRow; value: string }>
  >();

  // A registration with no person_id yet (unlinked, #137) has no one to promote a response onto.
  let skippedForNoPerson = 0;

  for (const response of responses) {
    const targetField = targetByDefinitionId.get(response.definition_id);
    const value = targetField ? trimmedValue(response.value) : null;
    if (!targetField || value === null) {
      continue;
    }
    const registration = registrationsById.get(response.registration_id);
    if (!registration) {
      continue;
    }
    if (!registration.person_id) {
      skippedForNoPerson++;
      continue;
    }

    let winners = winnersByPerson.get(registration.person_id);
    if (!winners) {
      winners = new Map();
      winnersByPerson.set(registration.person_id, winners);
    }
    const current = winners.get(targetField);
    if (!current || compareByRegistrationRecency(registration, current.registration) < 0) {
      winners.set(targetField, { registration, value });
    }
  }

  if (skippedForNoPerson > 0) {
    winston.warn(`Skipped ${skippedForNoPerson} custom_field_responses on registrations with no person_id`, {
      skippedForNoPerson,
    });
  }

  const peopleById = new Map<string, PersonRow>();
  for (const person of people) {
    if (person.id) {
      peopleById.set(person.id, person);
    }
  }

  const patches: PersonPatch[] = [];
  for (const [personId, winners] of winnersByPerson) {
    const person = peopleById.get(personId);
    const patch: Partial<PersonRow> = {};
    for (const [targetField, winner] of winners) {
      const currentValue = person?.[targetField];
      // Gap-fill only: a column already holding a value, staff-entered or from an earlier run, is
      // never replaced.
      if (currentValue == null || currentValue === "") {
        patch[targetField] = winner.value;
      }
    }
    if (Object.keys(patch).length > 0) {
      patches.push({ id: personId, patch });
    }
  }

  return patches;
}

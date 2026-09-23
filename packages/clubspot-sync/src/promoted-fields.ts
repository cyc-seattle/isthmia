import winston from "winston";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  PersonRow,
  PROMOTABLE_PERSON_FIELDS,
  PromotablePersonField,
  PromotedFieldRow,
} from "@cyc-seattle/crm";
import { normalizeName } from "./people.js";
import { RegistrationWithClubspot } from "./schema.js";

/**
 * Copies a staff-configured set of custom field responses onto `people` columns, so a question
 * asked on every camp (e.g. "School") becomes a column instead of a three-table join. Pure: takes
 * CRM rows only, no Parse and no Directus, so the whole pass is unit-testable without either.
 *
 * Gap-fill, not overwrite: a promoted value fills an empty column and never replaces one, matching
 * `fillGapsPatch`'s behavior for every other `people` scalar (#137 revisits this for all fields).
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
function buildTargetByDefinitionId(
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
 * Ranks the registrations answering one target field for one person, to pick whose response
 * wins: non-archived before archived, then most recently registered, then
 * `clubspot_registration_id` descending as a stable tiebreak - a comparator that could flap would
 * write a Directus revision every hour. Archived ranks last rather than being excluded, so a
 * cancelled registration's answer can still fill a column nothing else answers.
 */
function compareForPromotion(a: RegistrationWithClubspot, b: RegistrationWithClubspot): number {
  if (a.archived !== b.archived) {
    return a.archived ? 1 : -1;
  }
  if (a.registered_at !== b.registered_at) {
    return a.registered_at > b.registered_at ? -1 : 1;
  }
  return a.clubspot_registration_id > b.clubspot_registration_id ? -1 : 1;
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
  registrations: readonly RegistrationWithClubspot[],
  people: readonly PersonRow[],
): PersonPatch[] {
  if (promotedFields.length === 0) {
    winston.info("No promoted_fields configured; skipping the promotion pass");
    return [];
  }

  const targetByDefinitionId = buildTargetByDefinitionId(promotedFields, definitions);

  const registrationsById = new Map<string, RegistrationWithClubspot>();
  for (const registration of registrations) {
    if (registration.id) {
      registrationsById.set(registration.id, registration);
    }
  }

  // The current best response per person, per target field.
  const winnersByPerson = new Map<
    string,
    Map<PromotablePersonField, { registration: RegistrationWithClubspot; value: string }>
  >();

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

    let winners = winnersByPerson.get(registration.person_id);
    if (!winners) {
      winners = new Map();
      winnersByPerson.set(registration.person_id, winners);
    }
    const current = winners.get(targetField);
    if (!current || compareForPromotion(registration, current.registration) < 0) {
      winners.set(targetField, { registration, value });
    }
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

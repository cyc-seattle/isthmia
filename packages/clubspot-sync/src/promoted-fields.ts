import winston from "winston";
import { PersonRow } from "@cyc-seattle/crm";
import {
  CustomFieldDefinitionRow,
  CustomFieldResponseRow,
  ParticipantRow,
  PROMOTABLE_PERSON_FIELDS,
  PROMOTABLE_REGISTRATION_FIELDS,
  PromotablePersonField,
  PromotableRegistrationField,
  PromotedFieldRow,
  RegistrationRow,
} from "@cyc-seattle/clubspot";
import { normalizeName } from "./people.js";
import { CustomFieldResponseInput } from "./registrations.js";
import { emptyFieldTally, FieldTally, parseYesNo, planSyncedField, resolveBase } from "./synced-fields.js";

/**
 * Copies a staff-configured set of custom field responses onto `people` columns (e.g. "School"),
 * or onto a `registrations` column answered fresh by each registration (`share_contact`; design
 * doc "Sync: a registration-level promoted field").
 *
 * Both targets share the same two paths, pure, and both following the one CRM field rule (#137):
 * - `planPromotedFieldSync`/`planRegistrationPromotedFieldSync` run once per registration, inside
 *   `syncRegistrations` (`sync-run.ts`). The `people` path is gated on the same
 *   newest-linked-participant check `people` and `medical_profiles` use; the `registrations` path
 *   isn't, since each registration answers only for itself. `custom_field_responses` is itself the
 *   mirror here: `base` is what the response row held before this run's write, `v` is what
 *   Clubspot sends now - so a changed answer replaces a stale one (and counts as a replaced staff
 *   edit if the CRM value was neither), and a blank is never written.
 * - `planPromotedFields` runs once at the end of every run, across every camp, as a fallback: it
 *   fills a `people` column that's still null for a registration the per-registration path didn't
 *   reach this run - one outside every camp's watermark, say - ranked across every camp, since the
 *   winning response for a person can come from any of them. It also fills a `registrations` row's
 *   own null `share_contact` from that registration's own stored answer, with no ranking, since the
 *   field is per registration rather than per person.
 */
export interface PersonPatch {
  id: string;
  patch: Partial<PersonRow>;
}

// `custom_field_responses.field_type` values that hold a plain string worth promoting - a
// file_upload response isn't a scalar.
const SCALAR_FIELD_TYPES = new Set(["text", "select", "radio"]);

/**
 * A `promoted_fields` row's resolved destination - `people` (carried onto the person) or
 * `registrations` (answered fresh by each registration; see `synced-fields.ts`'s boolean
 * `SyncedFieldValue` and {@link planRegistrationPromotedFieldSync}).
 */
export type PromotedFieldTarget =
  | { kind: "person"; field: PromotablePersonField }
  | { kind: "registration"; field: PromotableRegistrationField };

function resolveTarget(targetField: string): PromotedFieldTarget | undefined {
  if ((PROMOTABLE_PERSON_FIELDS as readonly string[]).includes(targetField)) {
    return { kind: "person", field: targetField as PromotablePersonField };
  }
  if ((PROMOTABLE_REGISTRATION_FIELDS as readonly string[]).includes(targetField)) {
    return { kind: "registration", field: targetField as PromotableRegistrationField };
  }
  return undefined;
}

/**
 * Splits a unified {@link buildTargetByDefinitionId} map into its `people` and `registrations`
 * halves, so each pass's own plan function sees only the definitions it can write - a
 * `share_contact` target must never reach the `people` pass, and vice versa.
 */
export function splitPromotedFieldTargets(targetByDefinitionId: ReadonlyMap<string, PromotedFieldTarget>): {
  person: Map<string, PromotablePersonField>;
  registration: Map<string, PromotableRegistrationField>;
} {
  const person = new Map<string, PromotablePersonField>();
  const registration = new Map<string, PromotableRegistrationField>();
  for (const [definitionId, target] of targetByDefinitionId) {
    if (target.kind === "person") {
      person.set(definitionId, target.field);
    } else {
      registration.set(definitionId, target.field);
    }
  }
  return { person, registration };
}

/** `custom_field_responses.value` is nullable, and both null and "" mean "left blank". */
export function trimmedValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

type DefinitionWithId = CustomFieldDefinitionRow & { id: string };

/**
 * Maps each scalar-typed definition to the target it promotes to - a `people` column or a
 * `registrations` one (see {@link PromotedFieldTarget}) - by matching its normalized label against
 * the configured labels. A configured label matching no definition at all warns once per run,
 * naming the label - it's a typo or a question no camp asks any more. A config row naming a target
 * outside `PROMOTABLE_PERSON_FIELDS`/`PROMOTABLE_REGISTRATION_FIELDS` also warns and is skipped,
 * rather than written by string.
 */
export function buildTargetByDefinitionId(
  promotedFields: readonly PromotedFieldRow[],
  definitions: readonly CustomFieldDefinitionRow[],
): Map<string, PromotedFieldTarget> {
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

  const targetByDefinitionId = new Map<string, PromotedFieldTarget>();
  const warnedLabels = new Set<string>();

  for (const config of promotedFields) {
    const target = resolveTarget(config.target_field);
    if (!target) {
      winston.warn(`promoted_fields row targets "${config.target_field}", which isn't a promotable column`, {
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
          targetByDefinitionId.set(definition.id, target);
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
 * Whether the per-registration promoted-fields sync needs a fallback lookup at all (#137 review,
 * read-volume finding). {@link planPromotedFieldSync} only reaches for `fallbackByTargetField`
 * through {@link resolveBase} when a response's own definition has no stored row yet, so a
 * registration whose own `custom_field_responses` already cover every promotable response it sent
 * never needs the fallback registration's answers read at all.
 */
export function needsFallbackTargetValues(
  targetByDefinitionId: ReadonlyMap<string, PromotablePersonField>,
  responses: readonly CustomFieldResponseInput[],
  existingResponses: readonly CustomFieldResponseRow[],
): boolean {
  const existingDefinitionIds = new Set(existingResponses.map((row) => row.definition_id));
  return responses.some(
    (response) =>
      targetByDefinitionId.has(response.customFieldID) && !existingDefinitionIds.has(response.customFieldID),
  );
}

/**
 * Applies the one CRM field rule (#137) to one registration's promotable responses. `response` is
 * this registration's own raw `customFieldsArray`; `existingResponses` is its own
 * `custom_field_responses` rows as stored before this run's write - the `base` side of the rule,
 * same as `participants` is for every other curated field. `fallbackByTargetField` is the person's
 * previous newest OTHER linked registration's own answer, keyed by target field rather than
 * definition id - a fallback registration can belong to a different camp, whose custom field
 * definitions were cloned with different ids (see `buildTargetByDefinitionId`'s note), so matching
 * it against the same target field is the only thing that still lines up. Used - via
 * {@link resolveBase} - only where this registration has no stored response of its own for a
 * definition: a newly linked registration's first sync has nothing in `existingResponses` yet, so
 * without it a changed answer would only ever fill a null column (#137). `currentPerson` is the
 * resolved person's current value for every promotable column.
 *
 * The caller gates this on the newest-linked-participant check - an older registration's answer
 * must never overwrite a newer one's, same as any other curated field.
 */
export function planPromotedFieldSync(
  targetByDefinitionId: ReadonlyMap<string, PromotablePersonField>,
  responses: readonly CustomFieldResponseInput[],
  existingResponses: readonly CustomFieldResponseRow[],
  currentPerson: Partial<Record<PromotablePersonField, string | null>>,
  fallbackByTargetField: ReadonlyMap<PromotablePersonField, string> = new Map(),
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
    const ownBase = existing ? trimmedValue(existing.value) : undefined;
    const fallbackBase = fallbackByTargetField.get(targetField);
    const base = resolveBase(ownBase, fallbackBase);
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

export interface RegistrationPromotedFieldSyncPlan extends FieldTally {
  patch: Partial<Pick<RegistrationRow, "share_contact">>;
  /** Counted and logged, never written - an answer that parsed as neither "Yes" nor "No". */
  unknownAnswers: number;
}

/**
 * The registration-level counterpart to {@link planPromotedFieldSync} (design doc "Sync: a
 * registration-level promoted field"). Each registration answers only for itself: there's no
 * newest-linked-participant gate and no fallback to another registration's answer, because
 * `share_contact` is never carried onto the person. `rawAnswers` and `storedResponses` are already
 * narrowed to the definitions a `promoted_fields` row maps to `share_contact` - the caller does
 * that matching the same way {@link buildTargetByDefinitionId} does for `people` fields.
 * `storedResponses` is this registration's own `custom_field_responses` as stored before this
 * run's write - the `base` side of the field rule (#137).
 */
export function planRegistrationPromotedFieldSync(
  rawAnswers: readonly CustomFieldResponseInput[],
  storedResponses: readonly CustomFieldResponseRow[],
  currentShareContact: boolean | null,
): RegistrationPromotedFieldSyncPlan {
  const storedByDefinitionId = new Map(storedResponses.map((row) => [row.definition_id, row] as const));

  const patch: Partial<Pick<RegistrationRow, "share_contact">> = {};
  const tally = emptyFieldTally();
  let unknownAnswers = 0;

  for (const answer of rawAnswers) {
    const v = parseYesNo(answer.response ?? null);
    if (v === undefined) {
      unknownAnswers++;
      winston.warn(`Custom field ${answer.customFieldID} answered neither "Yes" nor "No"; not writing share_contact`, {
        clubspotDefinitionId: answer.customFieldID,
      });
      continue;
    }
    const stored = storedByDefinitionId.get(answer.customFieldID);
    const base = stored ? (parseYesNo(stored.value) ?? undefined) : undefined;

    const outcome = planSyncedField(currentShareContact, base, v);
    if (outcome.action === "write") {
      patch.share_contact = outcome.value;
      tally.written++;
      if (outcome.replacedStaffEdit) {
        tally.replacedStaffEdits++;
        tally.replacedFields.push("share_contact");
      }
    } else if (outcome.reason === "blank") {
      tally.blankSkipped++;
    }
  }

  return { patch, ...tally, unknownAnswers };
}

export interface RegistrationPatch {
  id: string;
  patch: Partial<Pick<RegistrationRow, "share_contact">>;
}

export interface PromotedFieldsPlan {
  peoplePatches: PersonPatch[];
  registrationPatches: RegistrationPatch[];
}

/**
 * Fills a registration's own null `share_contact` from its own stored answer only - no
 * cross-registration ranking, unlike the `people` gap-fill below, since this field is answered by
 * each registration for itself (design doc "Sync: a registration-level promoted field").
 */
function planRegistrationGapFill(
  registrationTargetByDefinitionId: ReadonlyMap<string, PromotableRegistrationField>,
  responses: readonly CustomFieldResponseRow[],
  registrations: readonly RegistrationRow[],
): RegistrationPatch[] {
  const answerByRegistrationId = new Map<string, boolean>();
  for (const response of responses) {
    const targetField = registrationTargetByDefinitionId.get(response.definition_id);
    const value = targetField ? parseYesNo(response.value) : undefined;
    if (value !== null && value !== undefined) {
      answerByRegistrationId.set(response.registration_id, value);
    }
  }

  const patches: RegistrationPatch[] = [];
  for (const registration of registrations) {
    const answer = answerByRegistrationId.get(registration.id);
    if (answer !== undefined && registration.share_contact == null) {
      patches.push({ id: registration.id, patch: { share_contact: answer } });
    }
  }
  return patches;
}

/**
 * Plans the `people` and `registrations` patches for one run of the promotion pass. Takes every
 * input as CRM rows - `promoted_fields`, `custom_field_definitions`, `custom_field_responses`,
 * `registrations`, `participants`, and the current `people` rows - and returns only the ids whose
 * column is currently empty and has a winning response to fill it. An empty `promoted_fields` does
 * nothing, logged at info so "not seeded yet" doesn't look like a bug.
 */
export function planPromotedFields(
  promotedFields: readonly PromotedFieldRow[],
  definitions: readonly CustomFieldDefinitionRow[],
  responses: readonly CustomFieldResponseRow[],
  registrations: readonly RegistrationRow[],
  participants: readonly Pick<ParticipantRow, "id" | "person_id">[],
  people: readonly PersonRow[],
): PromotedFieldsPlan {
  if (promotedFields.length === 0) {
    winston.info("No promoted_fields configured; skipping the promotion pass");
    return { peoplePatches: [], registrationPatches: [] };
  }

  const { person: personTargetByDefinitionId, registration: registrationTargetByDefinitionId } =
    splitPromotedFieldTargets(buildTargetByDefinitionId(promotedFields, definitions));

  const registrationsById = new Map<string, RegistrationRow>();
  for (const registration of registrations) {
    registrationsById.set(registration.id, registration);
  }
  const personIdByParticipantId = new Map<string, string>();
  for (const participant of participants) {
    if (participant.id && participant.person_id) {
      personIdByParticipantId.set(participant.id, participant.person_id);
    }
  }

  // The current best response per person, per target field.
  const winnersByPerson = new Map<
    string,
    Map<PromotablePersonField, { registration: RegistrationRow; value: string }>
  >();

  // A registration whose participant has no resolved person yet (unlinked, #137) has no one to
  // promote a response onto.
  let skippedForNoPerson = 0;

  for (const response of responses) {
    const targetField = personTargetByDefinitionId.get(response.definition_id);
    const value = targetField ? trimmedValue(response.value) : null;
    if (!targetField || value === null) {
      continue;
    }
    const registration = registrationsById.get(response.registration_id);
    if (!registration) {
      continue;
    }
    const personId = personIdByParticipantId.get(registration.participant_id);
    if (!personId) {
      skippedForNoPerson++;
      continue;
    }

    let winners = winnersByPerson.get(personId);
    if (!winners) {
      winners = new Map();
      winnersByPerson.set(personId, winners);
    }
    const current = winners.get(targetField);
    if (!current || compareByRegistrationRecency(registration, current.registration) < 0) {
      winners.set(targetField, { registration, value });
    }
  }

  if (skippedForNoPerson > 0) {
    winston.warn(`Skipped ${skippedForNoPerson} custom_field_responses on registrations with no resolved person`, {
      skippedForNoPerson,
    });
  }

  const peopleById = new Map<string, PersonRow>();
  for (const person of people) {
    if (person.id) {
      peopleById.set(person.id, person);
    }
  }

  const peoplePatches: PersonPatch[] = [];
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
      peoplePatches.push({ id: personId, patch });
    }
  }

  const registrationPatches = planRegistrationGapFill(registrationTargetByDefinitionId, responses, registrations);

  return { peoplePatches, registrationPatches };
}

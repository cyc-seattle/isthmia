# Promoting custom field responses to `people` columns

## Context

Clubspot asks the same question ("School") on every camp, and a `custom_field_definitions` row
exists per camp rather than per club — Clubspot clones the field with a new `objectId`, and its
label drifts between clones (`packages/crm/schema.yaml:74-77`,
`packages/clubspot-sync/src/registrations.ts:291-296`). The mapping deliberately leaves grouping
"the same logical question across camps" to reporting.

That leaves the answers reachable only through a three-table join. A staff member who wants to
filter or group people by school has no column to do it with: `PersonRow`
(`packages/crm/src/people.ts:2-14`) has no `school`, and `custom_field_responses` keys on the
per-camp definition, not on the question.

`custom_field_responses` is also empty in production — all 38 camps failed at or before
`registration_billing`, one line before `planCustomFieldResponses`
(`packages/clubspot-sync/src/sync-run.ts:427`). This branch fixes that, so this design assumes
responses exist but has never been run against real ones.

## Approach

A staff-maintained `promoted_fields` collection, one row per target column, plus a third pass in
`clubspot-sync` that runs once per run after the camp loop.

**Schema (`packages/crm`).** Two additions, both additive:

- `people.school` — nullable `character varying(255)`, `interface: input`, modelled on
  `people.street` (`packages/crm/schema.yaml:2284-2322`).
- `promoted_fields` — `target_field` (string, `interface: select-dropdown`, choices limited to the
  promotable columns) and `labels` (`type: json`, `interface: tags`). JSON rather than CSV because a
  Clubspot label may contain a comma. `schema.yaml` is snapshot-generated, not hand-written
  (`packages/crm/README.md:11-13`), so both go in through a local Directus and `directus schema
snapshot`.

`packages/crm/src` gains `PromotedFieldRow` and a `PROMOTABLE_PERSON_FIELDS` allow-list naming the
`PersonRow` keys promotion may write — `school` only, today. The allow-list, not the config row, is
what makes the write type-safe: a row naming anything else is skipped with a warning, never written
by string. It also settles type coercion — every promotable target is a nullable text column, so
there is no coercion. A date, number or enum target is out of scope; adding one means deciding how a
free-text response parses, which this design does not.

**Plan function (`packages/clubspot-sync/src/promoted-fields.ts`).** `planPromotedFields` takes CRM
rows only — config, definitions, responses, registrations, and the `people` rows' current values —
and returns `{ id, patch }[]`. No Parse, no Directus, no Clubspot types at all, which makes it the
most testable function in the package.

- **Label matching** reuses `normalizeName` (`packages/clubspot-sync/src/people.ts:11-21`). It
  lowercases, replaces punctuation with a space and collapses whitespace, so `Race / Ethnicity` and
  `Race/Ethnicity` normalize to the same key on their own. The explicit list then carries genuinely
  different wording (`School` vs `School Name`). A configured label matching no definition warns
  once per run, naming the label — it is a typo or a question no camp asks any more, and neither
  should be silent.
- **Which value wins.** Responses for one person are ranked by their registration: non-archived
  before archived, then `registrations.registered_at` descending (NOT NULL,
  `packages/crm/schema.yaml:3773`, written from Clubspot's `confirmed_at`,
  `registrations.ts:78-86`), then `clubspot_registration_id` descending as a stable tiebreak. An
  arbitrary-but-deterministic tiebreak matters: a comparator that can flap writes a revision every
  hour. Archived ranks last rather than being excluded, so a cancelled registration's answer still
  fills a column nothing else answers.
- **Guards.** A blank or whitespace-only response is not a value (`custom_field_responses.value` is
  NOT NULL, `schema.yaml:1214`, so "" arrives as a row). Promotion never clears a column: no winning
  response means no patch. Definitions whose `field_type` is not `text`, `select` or `radio` are
  skipped — `file_upload` responses are not scalars (`packages/clubspot-sdk/src/types.ts:111-122`).
- **Overwrite, not gap-fill.** A promoted column follows the README's rule
  (`packages/clubspot-sync/README.md:82-86`): Clubspot owns it, a staff edit is overwritten, fix it
  in Clubspot. This diverges from how `people` is otherwise written — `fillGapsPatch`
  (`people.ts:105-120`, `docs/crm-schema.md:57`) — and that needs saying in the README, because a
  reader will assume every `people` column is gap-filled. The reason the divergence is safe is that
  gap-fill exists to stop two registrations ping-ponging one column; promotion has a single
  deterministic winner, so it converges instead, and a kid who changes school gets the new one.

**Executor (`sync-run.ts`).** A `promotePeopleFields` step after the camp loop, in its own
try/catch. It is run-level because the winning response can come from any camp, and isolated so a
config problem cannot mask a camp's result — a throw there logs and marks the run failed without
touching the per-camp `sync_program_runs` rows. Counts are logged and returned on `RunSyncResult`;
no new `sync_runs` column, matching the deferral in `clubspot-sync-bad-data.md`'s open question 2.

Inputs are almost free: `readSharedTables` already reads `custom_field_definitions`,
`custom_field_responses` and `registrations` in full (`sync-run.ts:126-162`). It adds two reads —
`promoted_fields`, and `people` limited to `fields: ["id", "school"]` (`directus.ts:81-105`). That
is narrower than the full-table read the comment at `sync-run.ts:108-112` rules out, and worth
noting there. Diff-only patches mean a steady state writes nothing, so reconciling every person
every run costs one read, not a write per person.

**Permissions.** The clubspot-sync machine policy gets `read` on `promoted_fields`
(`packages/infrastructure/src/crm/index.ts:97-112`); it already holds `update` on `people`. Staff
CRUD comes free from `collectionsInSchema` (`crm/index.ts:43-56`). No GCP grant, so
`packages/infrastructure/src/config.ts` is untouched.

**The `School` row is created by hand** in the Data Studio, once, and documented. Pulumi manages
collections and fields, not rows, and a Pulumi-managed row would revert a staff edit to its labels
on the next apply — the opposite of what a staff-maintained table needs. An empty
`promoted_fields` logs at info and does nothing, so "not seeded yet" does not look like a bug.

**History is not lost.** `people.school` is a current-value projection; every response stays in
`custom_field_responses`, and each change to the column is in Directus's revision history
(`docs/crm-schema.md:69-88`).

**Migration.** A nullable column and a new empty collection are both the safe direction, and
neither needs a backfill — the first run after the deploy populates `school` from whatever responses
exist. `scripts/deploy` applies `infrastructure` (the image) before `crm` (the schema), so the run
between them reads a `promoted_fields` that does not exist yet and fails its promotion pass. The
camps still sync, and the next hourly run succeeds.

## Alternatives

- **A Directus Flow.** `directus schema snapshot` does not capture flows, so the logic would live
  only in the instance, outside git and outside vitest.
- **A separate Cloud Run job.** A new image, schedule and identity to re-read tables the sync
  already has in memory.
- **A pass inside the per-camp loop.** The winner can come from another camp, so it would either
  churn or depend on camp order.
- **One row per (target, label) pair** instead of a `labels` array. Simpler typing, but the user
  asked for a list per target and the Data Studio edits that more easily.
- **Free-text `target_field` validated against Directus's `/fields/people`.** Lets staff promote a
  new column with no deploy, but makes the write dynamically typed and pushes type coercion to
  runtime. See the open question.
- **Match on `cloned_from`** (`packages/clubspot-sdk/src/types.ts:121`) instead of labels. Only
  links clones back to one ancestor, and says nothing about a question re-typed by hand — and the
  user wants the mapping visible and editable.

## Decisions

- **Gap-fill, not overwrite.** A promoted value fills an empty column and never replaces one, matching
  `fillGapsPatch`'s behavior for every other `people` scalar. The broader question of how a manual
  edit and an incoming sync should interact is #137, and this follows whatever that settles.
- **The target stays a code allow-list.** Adding a promoted target is a change in `packages/crm` plus
  a deploy, not staff config.

## Open questions

1. **Overwrite or staff-owned?** This designs overwrite: Clubspot wins, a staff edit to
   `people.school` is replaced on the next run. The alternative is gap-fill — the first promoted
   value sticks and staff may correct it, but a school change never lands. It is a one-line swap to
   `fillGapsPatch` in the same function, so the choice is cheap to revisit but should be made before
   the README paragraph is written.
2. **Must a future promoted target be pure config?** With the allow-list, promoting
   `people.gender` — or any new column — is a one-line change in `packages/crm` plus a deploy. If
   staff need to add targets without a deploy, that is the free-text variant above and its runtime
   coercion problem.

## Steps

1. **Schema and row types.** Add `people.school` and the `promoted_fields` collection by
   regenerating `packages/crm/schema.yaml` from a local Directus; add `school` to `PersonRow`,
   `PromotedFieldRow` and `PROMOTABLE_PERSON_FIELDS` in `packages/crm/src`. Verify: `just
directus-local` applies the snapshot to a fresh instance, and `just build` across the workspace.
2. **Permission rule.** `read` on `promoted_fields` for the clubspot-sync policy in
   `packages/infrastructure/src/crm/index.ts`. Verify: `just diff` shows exactly one added resource.
3. **`planPromotedFields`.** The pure plan function and its unit tests: label normalization
   (including the `Race / Ethnicity` pair), the ranking rule, a tie, a blank response, a
   non-promotable target, a label matching nothing, a non-text `field_type`, and an unchanged column
   producing no patch. Independent of steps 1-2 only for review order; it imports the types from
   step 1.
4. **Wire the pass into `sync-run.ts`.** The two reads, the isolated try/catch, the counts on
   `RunSyncResult`, and the note on the `SharedTables` comment about the narrowed `people` read.
   Verify: a `sync-run` test seeding `promoted_fields`, `custom_field_responses` and `registrations`
   through the existing fetch mock (`packages/clubspot-sync/test/sync-run.test.ts:29-46`), asserting
   the `people` PATCH; plus one asserting a failing promotion pass leaves camp results intact and
   the run failed.
5. **Write it down.** The behavior and the divergence from `fillGapsPatch` in
   `packages/clubspot-sync/README.md`; the collection, the ranking rule and the manual `School` row
   in `docs/crm-schema.md`; a checkbox for that row in `docs/manual-setup.md` §6, per its own
   closing rule (`docs/manual-setup.md:149`). Code comments must carry the ranking rule and the
   overwrite decision themselves — they cannot cite this doc.

Verification after the deploy is one query: people with a non-null `school`, against the count of
distinct participants holding a response under a configured label. A `--dry-run` against a camp with
real responses is the cheap check before it.

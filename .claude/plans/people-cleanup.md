# People cleanup: a participant mirror, curated people, and merging

Covers #137 and #133. The participant candidate-fetch fix is in (13553475). All steps ship in one
PR on this branch. Each step is deployed before the next one, and each leaves prod working, except
the Clubspot-id rebuild (step 9), which is a hard cutover run from the runbook in step 10.

## Context

- **No durable Clubspot person.** A Clubspot `Participant` is the form snapshot for one
  registration. All 2048 registrations have a distinct `clubspot_participant_id`, so identity
  resolution is ours alone. Today the sync writes the form straight into `people` with
  `fillGapsPatch` (`packages/clubspot-sync/src/people.ts:105`, `person-sync.ts:84,106`). After a
  column holds a value, Clubspot can never change it, and nothing logs the dropped update (#137).
- **One email and one phone.** `people.email` and `people.phone` hold a single value each. Real
  people have several, and the values change. The matcher (`person-sync.ts:136`) and gsuite-sync
  (`gsuite-sync/src/audit.ts:77`) see only the one value.
- **Medical flaps.** `syncMedicalProfile` overwrites exactly (`person-sync.ts:250`). When several
  participants resolve to one person, the profile flips between their answers on every run.
- **Duplicates, and a merge that loses data.** There are about 200 duplicate groups (#133). Every FK
  to `people` is `on_delete: CASCADE`, so a reference the manual merge
  (`docs/crm-schema.md:91-97`) misses is deleted with the duplicate:
  - `contacts.subject_id` and `contact_id` (`packages/crm/schema.yaml:1852,1873`)
  - `medical_profiles.person_id`, unique (`:1894`)
  - `program_role_assignments.person_id` (`:1915`)
  - `registrations.person_id` and `event_staff.person_id` (`packages/clubspot/schema.yaml:3952,3805`)
  - `people.directus_user_id` is also unique (`packages/directus/schema.yaml:908`).
- **No per-run record.** `sync_tasks` rows are keyed by target and reused (`taskKey`,
  `packages/directus/src/queue.ts`). Even the `sync_run` parent row is stable
  (`sync-run.ts:669-682`). No row exists for one execution.
- **Two ids per Clubspot row.** Every Clubspot collection has a generated uuid `id` plus a unique
  `clubspot_*_id` column, and the sync translates between them through lookup maps
  (`indexByClubspotId`, `sync-run.ts:288,330-345`; `requireLookup`, `schedule.ts:25`).
  `participants` already uses the objectId as its PK (`packages/clubspot/schema.yaml:1487`).
- **Staff can edit synced data.** The Staff loop grants full CRUD on every collection except
  `participants` (`packages/infrastructure/src/crm/index.ts:73`). A staff edit to a Clubspot row is
  overwritten on the next sync. Only `sessions` sets an archive field (`clubspot/schema.yaml:339`),
  so cancelled and archived rows show in the Data Studio by default.

## Approach

### A `participants` mirror (`packages/clubspot`)

- One row per Clubspot Participant objectId. It holds the form's participant, guardian,
  emergency-contact, and medical fields, as Clubspot has them. The sync overwrites the row freely,
  nulls included.
- `participants.person_id` is the only link into the CRM, with `on_delete: SET NULL`. The matcher
  sets it once, when it creates the participant, and never re-resolves it. Staff may change it.
  When the matcher finds no match, the sync creates a person.
- `registrations.participant_id` (unique) replaces `registrations.person_id`. A merge then
  relinks only participants, and registrations follow. Every consumer reaches a person through
  `participant_id.person_id`:
  - `gsuite-sync/src/membership.ts:83` and the audit
  - `promoted-fields.ts:161` and `sync-run.ts:424`
  - the Guardian filters on `registrations` and `registration_entries`
    (`packages/infrastructure/src/crm/index.ts:107-111`)
- The permission rules change in `crm/index.ts`. These are Directus rules, not GCP IAM, so
  `config.ts` does not change.
  - Staff can read `participants` and can update only `person_id`, with a field-level rule.
  - Coach gets no access to `participants`, because it holds medical and guardian data.
  - `gsuite-sync` can read `participants` fields `id` and `person_id` only.
  - Guardian can read `participants` through `person_id.my_contacts`. Guardian access to
    `medical_profiles` does not change.

### Clubspot objectIds as primary keys (`packages/clubspot`)

- **Synced rows.** `camps`, `sessions`, `classes`, `entry_caps`, `registrations`,
  `registration_entries` (from `clubspot_session_join_id`), `registration_billing`, and
  `custom_field_definitions` take a string PK, entered by the sync, as `participants` does. Every
  `clubspot_*_id` column goes, and every FK between Clubspot collections becomes a string. The
  lookup maps and `requireLookup` go with them: a parent FK is the parent's objectId, and Postgres
  rejects one that doesn't exist.
- **Derived rows.** Directus supports only a single-field PK, and it can't declare a composite
  unique. So the PK joins the two parent ids, and both parents stay as real FK columns:
  - `custom_field_responses`: `"<registration id>:<definition id>"`
  - `session_classes`: `"<session id>:<class id>"`
- `event_staff` keeps its uuid for now. It gets its key when a sync first writes it (#165 may show
  what Clubspot provides). Its `session_id` still becomes a string FK.
- `registration_billing` keys on the billing objectId. When Clubspot swaps a registration's
  billing object, the sync deletes the old row, since `registration_id` is unique
  (`registrations.ts:296-299`).
- `promoted_fields` is staff config, and keeps its uuid.
- `registrations.participant_id` is NOT NULL from the rebuild on, since every recreated row sets it.
  `registrations.person_id` stays, nullable, until step 15.
- The promotion tiebreak (`promoted-fields.ts:113`) and the newest-participant order below use
  `registrations.id`.
- **Nothing outside the Clubspot collections holds their ids** except `audit_findings.subject` for
  `class_without_program` and `mismatched_revenue_account` (`gsuite-sync/src/audit.ts:170,249`).
  `sync_tasks` targets are Clubspot camp objectIds and program and group ids
  (`sync-run.ts:724-729`, `gsuite-sync/src/run.ts:134-253`), so they survive. No other package has
  an FK into a Clubspot collection. `contact_points.participant_id` points at `participants`, which
  is not rebuilt. gsuite-sync's joins are by `id` (`membership.ts:64-78`), so it needs a rebuilt
  image for the row types and no logic change.

### Archive settings

These only set the collection's archive meta, with `archive_app_filter: true`:

- `sessions`: `archived`, `true`/`false`. This already exists.
- `registrations`: `archived`, `true`/`false`. The sync already writes it (`registrations.ts:106`).
- `camps`: `archived`, `true`/`false`. New in the rebuild, from Clubspot's own flag (`camps.ts:15`).
  Discovery skips archived camps, but a queued camp still reconciles (`sync-run.ts:687-690`).
- `registration_entries`: `status`, archive `cancelled`, unarchive `confirmed`.

No other Clubspot collection has an archive or status column.

### Clubspot collections are read-only to Staff

Editing happens in Clubspot. In `crm/index.ts`:

- The full-CRUD loop skips every collection in `collectionsInSchema` of
  `packages/clubspot/schema.yaml`, except `promoted_fields`, which is staff config.
- Staff read every Clubspot collection.
- Staff update only the hand-set fields, by a field-level rule: `classes.program_id` and
  `participants.person_id`.

Content Versioning stays off. History comes from revisions (`accountability: all`) and
`last_sync_run_id`. Coach, Guardian, and the sync policies do not change.

### History: `sync_runs` (`packages/directus`)

- Each job execution adds one row: `source`, `started_at`, `finished_at`, `status`, `counts` (json),
  and `error`. It sits beside `sync_tasks` and does not replace it.
- `participants` and `registrations` gain `last_sync_run_id`, with `SET NULL`. The sync sets it
  only in a patch that already changes something. Otherwise every row gets a revision every hour.
- To find what run X changed, read `directus_activity` and `directus_revisions` for the sync's
  user inside the run's time window. `accountability: all` is already set.

### Every email and phone: `contact_points`

`contact_points` is a new canonical collection in `packages/crm/schema.yaml`. It has these fields:

- `person_id`
- `kind`: `email` or `phone`
- `value`, and `normalized` (from `normalizeEmail` or `normalizePhone`)
- `source`: `form` or `staff`
- `last_seen_at`

`contact_points.participant_id` records the last form that used the value. It is an extension
field in `packages/clubspot/schema.yaml`, because it points at a Clubspot collection. Guardian and
emergency-contact values land on those people, through their `contacts` slot.

- **Why a collection, and not derived from the mirror.** The mirror can list what the forms said.
  It cannot hold a staff-added value, and it cannot show which person a guardian slot's value
  belongs to without a join through `contacts`. With the collection, a merge is one repoint.
- **The primary value stays on `people.email` and `people.phone`.** gsuite-sync, Listmonk (#71),
  and the Data Studio each keep one field to read. There is exactly one primary per person because
  it is a column. Directus has no partial unique index to enforce that in a child table.
- **Rules the sync enforces.** Directus cannot express a composite unique key either.
  - The sync upserts on (`person_id`, `kind`, `normalized`), and updates `last_seen_at` and
    `participant_id`. A merge removes duplicate rows.
  - The sync adds a `staff` row for any primary value that has no row yet, so the primary is
    always also in the list.
- **Choosing the primary.** The primary follows the rule for every CRM field (below). The only
  difference is a side effect: a replaced email or phone stays in `contact_points` as a
  non-primary.
- **Matching.** Candidate fetches that search by email (`person-sync.ts:136`) search
  `contact_points.normalized` and `people.email`, so any known address matches.
- **gsuite-sync.** It reads `contact_points` (grant `id`, `person_id`, `kind`, `normalized`). A live
  member whose address is a known non-primary email of a planned person raises a new
  `secondary_email_member` finding. It does not raise `unexpected_member` (`audit.ts:77`). This
  is what a primary change leaves behind in a group.

### One rule for every CRM field (#137)

`people`, `contacts`, `medical_profiles`, and the primary email and phone are all curated in the
CRM. They all follow one rule: **the most recent change wins, whoever made it.**

A person's **newest linked participant** is the one ranked first by this order:

1. Non-archived registrations before archived ones.
2. `registered_at`, newest first.
3. `registrations.id` as a tiebreak.

This is the order promotion uses today.

The rule compares two values:

- `base` is the value Clubspot sent last time, which the mirror holds.
- `v` is the value Clubspot sends now.

Both are in hand when the sync writes the mirror, so no state column is needed. For a newly
linked participant, `base` is the previous newest participant's value. The rule works like this:

- **`v` equals `base`:** do not write. A value Clubspot sends again never overrides anything, so a
  staff edit holds.
- **`v` differs from `base`:** Clubspot changed its answer. Write `v` over the CRM value. If the CRM
  value was neither `base` nor null, this replaces a staff edit, and the sync counts and logs it.
- **Null:** a blank value from Clubspot is never written, for any field. It does not count as a
  change. If a later non-null value differs from the last non-null `base`, it is written.
  - For medical data this means a removed allergy stays in the CRM until staff clear it.
- **First mirror write:** a participant's first mirror write only fills null columns. The backfill
  (migration step 3) runs before this rule ships (step 13), so every existing row has a `base`.

The rule covers every value a form feeds. That includes the fields of guardian and
emergency-contact people for their slot (`person-sync.ts:192,218`), and promoted
`custom_field_responses`. If the name in a slot no longer matches the linked contact person, the
sync counts and logs the update, and does not apply it. The promoted-fields pass
(`sync-run.ts:787`) keeps its run-level fill of null columns only.

The sync writes the CRM row before it writes the mirror row. After a crash between the two, the
next run sees the same change and applies it again, which is harmless. These are counted in
`sync_runs.counts`:

- each write
- each replaced staff edit
- each blank that was not written

The log records the person id and field name, with no values.

### Merge, unmerge, and review (#133)

We build no Directus extension.

- **Findings.** `clubspot-sync` raises two finding kinds:
  - `duplicate_person`: people with the same normalized name. `subject` is the keeper. `detail`
    lists each row's id and DOB, so a dismissal outlives email and phone edits.
  - `unlinked_participant`: `person_id` is null, which happens after staff delete a person.

  Staff approve a finding with a new `approved` status. They dismiss one with `dismissed`.
  `fingerprintFinding` and `planAuditFindingWrites` (`gsuite-sync/src/audit.ts:54,367`) move to
  `packages/directus`, and the owned kinds become a parameter.

- **Keeper.** The keeper is the person with the most linked participants. A tie goes to the row
  that has a `directus_user_id`, then to the smallest id. Values on the keeper win, including its
  primary email and phone. Values from the other rows fill only null columns.
- **Merge.** A run-level pass handles each approved finding before the camp loop. The job runs
  with `parallelism: 1`. The pass does these steps:
  1. Check that the rows still exist and still share a name. If not, set the finding back to
     `open`.
  2. Relink the participants to the keeper.
  3. Merge `medical_profiles`: the keeper's profile wins, and the other profiles fill its null
     fields. Then delete the other profiles. `person_id` is unique, so they must go before step 4
     repoints anything.
  4. Repoint `contacts`, `contact_points`, `program_role_assignments`, and `event_staff`.
     `contact_points` then holds the union of both lists.
  5. Delete rows that are now exact duplicates: `contacts` on (`subject_id`, `contact_id`,
     `relationship_type`), and `contact_points` on the upsert key. Also delete any contact that
     links a person to itself.
  6. Move `directus_user_id` if only a duplicate has one. If two rows have one, stop.
  7. Read every FK again, and delete the person only when nothing references it.

  Delete goes last, so a rerun completes a partial merge. A failure marks the run failed.

- **Unmerge.** Staff create a person and set the participant's `person_id` to it. The sync never
  re-resolves a linked participant, so the change is durable. Staff move contacts and
  `contact_points` by hand.
- **`on_delete: RESTRICT`.** This applies to every FK to `people` except `participants.person_id`,
  which stays `SET NULL`. Postgres then refuses to delete a person who still has references, so a
  missed FK fails loudly. Nothing deletes a person today except staff in the Data Studio. The
  clubspot-sync and gsuite-sync policies have no delete grant on `people`. A manual delete now
  takes several steps: first delete or repoint the person's contacts, contact points, medical
  profile, and role assignments.
- **Tested without Directus.** `findDuplicatePeople` and `planPersonMerge` are pure. A test reads
  every `packages/*/schema.yaml`. It checks two things for every relation to `people`:
  - the relation is in the merge's handled list
  - the relation is `RESTRICT`, except `participants.person_id`

  RESTRICT removes the silent data loss. The test still earns its place, for two reasons. A missed
  FK would otherwise surface in prod as a merge stuck on a failed delete. And a new FK, which Directus
  generates as CASCADE by default in a snapshot, would quietly lose RESTRICT.

- **Grants for clubspot-sync.** The policy (`crm/index.ts:140-176`) needs these grants:
  - create, read, and update on `participants`, `contact_points`, `sync_runs`, and `audit_findings`
  - read and update on `program_role_assignments`, and `event_staff`
  - delete on `people`, `contacts`, `contact_points`, and `medical_profiles`

### Migration

`/schema/apply` never renames. It drops a column and adds a new one, so each move below copies the
data before the old column goes. `people.email` and `people.phone` do not move.

1. **Links.** Before the rebuild, an idempotent pass creates a `participants` row
   (`id`, `person_id`) for each registration that has none, from `clubspot_participant_id` and
   `registrations.person_id`. `participants` is not rebuilt, so the rebuilt sync reuses these
   links rather than running the matcher again. It needs no Clubspot call.
2. **Rebuild.** The Clubspot collections are dropped and recreated with string PKs, and resynced
   from Clubspot. The step 10 runbook covers it.
3. **Mirror fields.** After the mirror ships, run `--camp <id> --since 1970-01-01` for every camp,
   so every participant gets its form fields.
4. **Contact points.** Seed `contact_points` from the mirror. Then add a `staff` row for any
   `people.email` or `people.phone` that no form used.
5. **Existing duplicates.** A one-time `--approve-matching-duplicates` flag approves each open
   `duplicate_person` finding whose rows share one non-null DOB. That is the documented
   participant rule (`docs/crm-schema.md:75`). Run it with `--dry-run` first, and review the list.

## Alternatives

- **A json sync-state column (the first draft).** The mirror already holds the base value.
- **Keep `registrations.person_id` next to `participant_id`.** Two links would have to stay in
  agreement, and a merge would have to update both.
- **Derive every email and phone from the mirror.** It cannot hold values that staff add, and it
  needs a join to know which guardian a value belongs to.
- **Put the primary flag on `contact_points`.** Nothing could enforce one primary per person, and
  every consumer would need a join.
- **A Vue module or an endpoint extension.** The substrate runs stock `directus/directus:12.3.1` with
  no extensions volume (`packages/substrate/deploy/docker-compose.yml:60`). The merge logic under
  it would be the same.
- **A Directus Flow.** Flows are not in the schema snapshot, and they cannot be tested in vitest.
- **Rewrite PKs in place with SQL.** It keeps revision history, but every FK and the Directus
  metadata would be rewritten by hand, with no test. The user chose rebuild and resync.

## Decisions

1. Every CRM field follows one rule: the most recent change wins, whoever made it. Email and phone
   differ only in a side effect, which is that a replaced value stays in `contact_points`. A blank
   value from Clubspot is never written, for any field.
2. `medical_profiles` stays curated in the CRM, under the same rule.
3. A participant with no match gets a new person.
4. Groups that share a name and one non-null DOB are approved after one review of the dry-run
   list.
5. `on_delete: RESTRICT` ships in this PR, on every FK to `people` except `participants.person_id`.
6. Everything ships in one PR. Each step is deployed in order before the merge.
7. Every Clubspot collection keys on its Clubspot objectId, and derived rows key on their joined
   parent ids. `event_staff` waits until a sync writes it. The migration is a rebuild and full
   resync. Losing the old rows' revision history is accepted.
8. Clubspot collections are read-only to Staff, except the hand-set fields. Content Versioning
   stays off.

## Steps

Steps marked **(schema)** edit a `schema.yaml` and must not run in parallel. **(apply)** needs a
schema apply. **(deploy)** needs `just deploy`. That command applies `infrastructure`, which holds
the images, and then `crm`, which holds the schema. So a step that changes both code and schema
must work with the old image and the new schema, and with the new image and the old schema. Step 9
is the one exception, and it runs only from the step 10 runbook.

1. Move `fingerprintFinding` and `planAuditFindingWrites` to `packages/directus`. `gsuite-sync`
   calls them. **(deploy)**
2. **(schema, apply)** In `packages/directus/schema.yaml`, add the `sync_runs` collection and the
   `approved` status choice on `audit_findings`. Both changes are additive.
3. `clubspot-sync` writes one `sync_runs` row per execution, and adds the grant. **(deploy)**
4. **(schema, apply)** In `packages/clubspot/schema.yaml`:
   - add `participants`, with its `person_id` and `last_sync_run_id` fields
   - add `registrations.participant_id` (nullable) and `registrations.last_sync_run_id`
   - make `registrations.person_id` nullable
   - add a `people` alias for linked participants

   Add the permission rules. This step only adds or relaxes, so the running image is unaffected.
   **(deploy)**

5. **(schema, apply)** Add `contact_points` in `packages/crm/schema.yaml`, and
   `contact_points.participant_id` in `packages/clubspot/schema.yaml`. Add the permission rules.
   **(deploy)**
6. Add the links pass (migration step 1) to `clubspot-sync`. It runs on the current schema.
   `planRegistrations`' update path pins `person_id` and `clubspot_participant_id` to the stored
   row, but not `participant_id` (1db7222d). Pin `participant_id` the same way, or the next run
   resets it to null. `last_sync_run_id` follows the History rule.
   **(deploy)** Then trigger the job, and check that every registration has a `participants` row.
7. Make the Clubspot collections read-only to Staff in `crm/index.ts`. Derive the list from
   `packages/clubspot/schema.yaml`. Add the `classes.program_id` update rule. Update the Staff line
   in `docs/crm-schema.md:162`. **(deploy)**
8. **(schema, apply)** Set the archive meta on `registrations` and `registration_entries`. Meta
   only, so the running image is unaffected. `camps` gets its archive meta in step 9.
9. **(schema)** The rebuild, in one commit, since neither half runs without the other:
   - `packages/clubspot/schema.yaml`: string PKs, joined PKs, no `clubspot_*_id` columns, string
     FKs, `registrations.participant_id` NOT NULL, and `camps.archived` with its archive meta
   - `packages/clubspot/src` row types
   - `clubspot-sync`: every plan keys and creates by `id`. The lookup maps go. A new registration
     reuses its `participants` row, or runs the matcher and creates one. The sync still writes
     `registrations.person_id`, from the participant.
   - the sync deletes a replaced `registration_billing` row, and writes `camps.archived`. Add the
     delete grant on `registration_billing` to the clubspot-sync policy in `crm/index.ts`.
   - the `readSharedTables` camp filter (`sync-run.ts:163`) and the tests
   - `gsuite-sync` builds against the new row types. No logic change.

   Do not deploy this step on its own.

10. **Runbook: the cutover.** There is no code in this step. Use an admin token against Directus
    for each call.
    1. Take a Cloud SQL backup of the Directus database. Rollback is to restore it and redeploy the
       previous commit.
    2. Pause `clubspot-sync-hourly` and `gsuite-sync-hourly` with
       `gcloud scheduler jobs pause --location us-west1`. Wait until no execution of either job is
       running.
    3. Export to files:
       - `classes`: `id`, `clubspot_class_id`, and `program_id`
       - `camps`: `id` and `clubspot_camp_id`
       - `audit_findings` where `status` is `dismissed` and `kind` is `class_without_program` or
         `mismatched_revenue_account`
       - the row count of every Clubspot collection, and of `people`
    4. Delete the Clubspot collections with `DELETE /collections/<name>`, children first:
       `custom_field_responses`, `registration_billing`, `registration_entries`, `entry_caps`,
       `session_classes`, `event_staff`, `registrations`, `custom_field_definitions`, `sessions`,
       `classes`, `camps`. Keep `participants` and `promoted_fields`. The apply refuses to delete a
       collection (`packages/infrastructure/src/directus/client.ts:548`), so this is by hand.
    5. Run `just deploy`. The apply recreates the collections.
    6. The permission rules on those collections went with them, and Pulumi state still lists them.
       Run `pulumi up` on the `crm` stack with `--replace` for each `DirectusPermissionRule` on a
       collection deleted in 10.4. Replace is safe, because create adopts an existing row and delete
       ignores a 404.
    7. Check that both schedulers are still paused.
    8. Execute `clubspot-sync-job` once with no args. Then, for every exported camp with no `camps`
       row yet, execute it with `--camp <id> --since 1970-01-01`.
    9. Restore each exported `program_id` onto `classes`, by `clubspot_class_id`. List any exported
       class that is missing.
    10. Compare the counts. Each Clubspot collection has at least its exported count. Every
        registration has a `person_id`. `people` has only as many new rows as there are new
        registrations.
    11. Execute `gsuite-sync-job` once. It resolves the old findings and raises new ones. For each
        exported dismissal, map its subject to the Clubspot id, and set the new finding with that
        kind and subject to `dismissed`. Then delete the old dismissed rows.
    12. Resume both schedulers.
11. The sync mirrors participants: every form field, and `last_sync_run_id`. **(deploy)** Then run
    migration step 3.
12. The sync upserts `contact_points` from forms, and the matcher searches them as well as
    `people.email`. **(deploy)** Then run migration step 4.
13. Replace `fillGapsPatch` and the exact medical overwrite with the one rule, for every field the
    rule covers. Record the counts in `sync_runs`. Update `packages/clubspot-sync/README.md:80-88`
    and `docs/crm-schema.md:87-89,139`. **(deploy)**
14. Move every consumer to `participant_id.person_id`: gsuite-sync, promoted fields, `sync-run.ts`,
    and the Guardian filters. Stop writing `registrations.person_id`. Add the gsuite-sync grants on
    `participants` and `contact_points`. Add the `secondary_email_member` finding. Both images and
    both filters change in one deploy. **(deploy)**
15. **(schema, apply)** Drop `registrations.person_id`. No code reads or writes it after step 14.
16. Add `findDuplicatePeople` and `planPersonMerge`, and the FK-coverage test, which adds `js-yaml`
    as a dev dependency. The RESTRICT check in the test waits for step 19.
17. Add the detection pass (`duplicate_person` and `unlinked_participant`) and the `audit_findings`
    grants. **(deploy)**
18. Add the merge executor and the delete grants. Rewrite "Merging a duplicate" in
    `docs/crm-schema.md` so it covers approving a finding and unmerging. **(deploy)**
19. **(schema, apply)** Set `on_delete: RESTRICT` on every FK to `people` except
    `participants.person_id`. These are in `crm`, `clubspot`, and the `contact_points` relation.
    Before you commit, check with `just directus-local` that `/schema/apply` changes a relation's
    `on_delete` in place. Turn on the RESTRICT check in the test. In `docs/crm-schema.md`, write
    down that a manual delete is now multi-step.
20. Add the `--approve-matching-duplicates` flag. Run it with `--dry-run` and review the list, then
    run it for real, then start the job.

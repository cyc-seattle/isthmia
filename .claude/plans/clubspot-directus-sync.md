# Sync Clubspot into the CRM

Issues #69 and #70. Replaces the spreadsheet-backed Clubspot sync with a Directus-backed one, and
replaces the config spreadsheet with discovery plus a sync log in Directus.

The package known as `people-hub` is renamed to `crm` first, and the rest of this doc uses the new
name.

## Context

Today one Cloud Run job reads a config worksheet and writes report worksheets:

- `packages/admin-functions/src/runner.ts:100` reads the "Reports" worksheet
  (`enabled`/`report`/`arguments`/`spreadsheetUrl`/`sheet`/`lastRun`/`success`/`webhook`) and runs
  each enabled row over the `lastRun` → `now` interval.
- `packages/admin-functions/src/reports.ts:15` is the base class. Five reports register in
  `runner.ts:14`: camps, participants, registrations, sessions, contacts.
- `packages/infrastructure/src/infrastructure/run-reports-job.ts:78` hardcodes
  `CONFIG_SPREADSHEET_ID`. Cloud Scheduler triggers the job hourly (`:117`).

The destination already exists. `packages/people-hub/schema.yaml` is a live Directus snapshot
applied by `packages/infrastructure/src/infrastructure/people-hub.ts:62`, with collections that
mirror Clubspot one for one. Directus is publicly reachable at `https://directus.<internalDomain>`
and is a plain reverse proxy (`packages/substrate/deploy/Caddyfile:14`), so a Cloud Run job reaches
it over the internet with no VPC connector.

Nothing writes to those collections yet. This design is that writer.

## Approach

### Rename people-hub to crm

One mechanical step, first, so everything after it is written in the new vocabulary:

- `packages/people-hub/` → `packages/crm/`, and the package name `@cyc-seattle/people-hub` →
  `@cyc-seattle/crm`. `pnpm-workspace.yaml` globs `packages/*`, so only `pnpm-lock.yaml` needs
  regenerating.
- `docs/people-hub-schema.md` → `docs/crm-schema.md`, including its `tags:` front matter.
- `packages/infrastructure/src/infrastructure/people-hub.ts` → `crm.ts`, the import in `index.ts:10`,
  the `peopleHubSchema` export, and the schema path at `people-hub.ts:55`.
- Prose references in `docs/architecture.md:176`, `docs/manual-setup.md:113`,
  `packages/substrate/deploy/docker-compose.yml:55`, `directus.ts:18`, `directus.ts:36`,
  `directus.ts:160`, `directus.ts:311`, `directus-client.ts:122`, `substrate-apply.ts:23`, and
  `CLAUDE.md`.

The five Pulumi resource names — `people-hub-schema`, `people-hub-staff`, `people-hub-coach`,
`people-hub-guardian`, and `people-hub-staff-ungood` — get renamed too. A resource name is part of
its URN, so Pulumi creates each new resource and deletes the old one. `DirectusRole` and
`DirectusUser` really do call `DELETE /roles/{id}`, `DELETE /policies/{id}`, and
`DELETE /users/{id}` (`directus.ts:266-280`, `directus.ts:353-356`).

**Recreate them; no aliases.** The roles are recreated in the same apply, the only Directus user is
the one this program provisions, and the CRM holds no data yet. `pulumi.Alias` would avoid the
delete but is not worth carrying for a system with nothing in it. Revisit only if someone assigns
roles by hand in the Directus UI before this lands.

### Where the sync code lives

A new package, `packages/clubspot-sync`. It depends on `clubspot-sdk` and `commodore` only — no
`gsuite`, no `googleapis`. The dependency graph is unchanged in direction.

`admin-functions` is not the right home. It keeps `roster.ts`, which genuinely needs Sheets and
Drive (`packages/admin-functions/src/roster.ts:2`), and it pulls in `google-spreadsheet` and
`googleapis`, which the sync never needs. `packages/people-hub/README.md:5` already sets the
precedent that a second Directus-backed app is its own package.

The package contains a small Directus REST client (static-token auth, `GET /items`, `POST /items`,
`PATCH /items`). It does not import
`packages/infrastructure/src/infrastructure/directus-client.ts` — an app must not depend on the
deployment package. That duplicates about 40 lines of `fetch` plumbing. Extracting a shared
`packages/directus` package that both use is the larger refactor. It is not part of this plan.

The sync sends no Google Chat notifications. It writes failures to the sync log and exits non-zero.
Notifications, and which package `notifications.ts` should live in, get their own issue.

### Shape of the sync

Follow `roster.ts`: a pure function builds a plan, a thin executor writes it. For each collection
the sync reads every existing row once (`GET /items/<collection>?limit=-1`), keys them by
`clubspot_*_id`, and computes creates and updates against the Clubspot objects. That makes the
whole mapping layer unit-testable with no Directus.

Two passes, with different rules:

- **Schedule** (`programs`, `sessions`, `classes`, `session_classes`, `entry_caps`) — full
  reconcile per camp, not watermark-filtered. `sessions.ts:56` already does this, for the same
  reason: a class, session, or cap can change without the camp's `updatedAt` moving.
  `session_classes` expands Clubspot's `allClasses` flag into explicit rows, per
  `docs/crm-schema.md`'s session_classes section.
- **Registrations** (`people`, `contacts`, `medical_profiles`, `registrations`,
  `registration_billing`, `registration_entries`, `custom_field_responses`) — filtered on
  `updatedAt` between the watermark and the run start, the same interval logic as `reports.ts:42`.

Entry removal gets a real fix. When a session is removed from a registration, Clubspot drops the
join object, so the current code marks every row for that participant "cancelled" first, then
rewrites the survivors (`participants.ts:111`). The hub version fetches the existing
`registration_entries` for that registration and sets `status = cancelled` on any whose
`clubspot_session_join_id` is gone. No global pre-pass.

### What the job syncs, and when

There is no config collection and no `enabled` toggle. The job syncs everything for one club. The
club id comes from a `CLUBSPOT_CLUB_ID` environment variable on the Cloud Run job, the same shape
as `CONFIG_SPREADSHEET_ID` today (`run-reports-job.ts:78`) and already an established variable name
in the SDK CLI (`packages/clubspot-sdk/src/main.ts:128`).

Each run:

1. List every non-archived `Camp` for the club, as `camps.ts:37` already does.
2. For each camp, decide whether anything changed since that camp's own watermark. A camp's
   `updatedAt` does not move when a child object changes, so the camp is checked with one
   `Parse.Query.count()` per child class, each filtered on `updatedAt >= watermark`: `CampSession`,
   `CampClass`, `Registration`, and `RegistrationCampSession`. If every count is zero and the
   camp's own `updatedAt` is older than the watermark, skip the camp.
3. Sync each camp that changed, and record one log row per camp.

Two known holes in step 2, both closed by the same rule:

- `EntryCap` has no pointer to a camp (`packages/clubspot-sdk/src/types.ts:338-342`), so a
  capacity-only change is invisible to the count queries.
- Nothing in Clubspot's `updatedAt` reveals a delete.

So any camp whose last successful sync is more than 24 hours old is synced regardless of the
counts. That is a refresh floor, not a snooze.

**Snooze is premature.** The cost the user is worried about is four `count()` calls per camp per
run. With tens of camps and an hourly schedule that is a few hundred cheap queries a day, against
the thousands of object reads a full pass costs. Add a snooze when a measurement says it is needed.

### The sync log

Two append-only collections replace the config worksheet. They hold status and, between them, the
watermark.

**sync_runs** — one row per job execution.

| Field                                 | Notes                                  |
| ------------------------------------- | -------------------------------------- |
| `id`                                  | primary key                            |
| `started_at`                          | timestamp, set at the start of the run |
| `finished_at`                         | timestamp, nullable until the run ends |
| `status`                              | string: `running`, `ok`, `failed`      |
| `programs_checked`, `programs_synced` | integer                                |
| `error`                               | text, nullable                         |

**sync_program_runs** — one row per camp the run touched.

| Field                            | Notes                                                  |
| -------------------------------- | ------------------------------------------------------ |
| `id`                             | primary key                                            |
| `run_id`                         | FK to `sync_runs`                                      |
| `program_id`                     | FK to `programs`, nullable on the first sync of a camp |
| `clubspot_camp_id`               | string, so a failed first sync still identifies itself |
| `started_at`, `finished_at`      | timestamp                                              |
| `status`                         | string: `ok`, `failed`, `skipped`                      |
| `items_created`, `items_updated` | integer                                                |
| `error`                          | text, nullable                                         |

**The watermark is per camp, not per run**: the greatest `started_at` among that camp's
`sync_program_runs` rows with `status = ok`, or the epoch if there are none. A run-level watermark
would lose data — if camp A succeeds and camp B fails in the same run, a run-level watermark would
advance past B's missed window. Use the run's `started_at`, not `finished_at`, so a Clubspot write
made during the run is picked up next time. `runner.ts:120` already gets this right today.

Retention is not designed here. The log grows by roughly one row per camp per hour. Revisit when it
is large enough to matter.

### Person identity

Pointers run from the registration-specific rows to `people`, and they are resolved **once, when
the row is created**. `registrations.person_id` is the participant. `contacts.person_id` is a
guardian or an emergency contact. On every later run the sync leaves an existing row's `person_id`
alone. It never re-resolves.

That is the whole reason a manual merge is durable. Staff repoint the FK, delete the loser, and no
later sync undoes it.

**Matching at creation.** Directus's REST filters give `_eq` and `_icontains` and nothing else —
there is no trigram or similarity operator over REST. So "fuzzy" means normalize, fetch a small
candidate set with an indexable filter, and compare in the client:

1. Normalize: trim, lowercase, collapse inner whitespace, strip punctuation from names. Normalize
   phone numbers to digits only.
2. Fetch candidates. With an email:
   `GET /items/people?filter[email][_eq]=<email>`. Without one:
   `GET /items/people?filter[last_name][_icontains]=<last name>&limit=50`.
3. Match in the client, by kind:
   - **Participant** — same normalized first and last name, and the same `date_of_birth`. If the
     participant has no date of birth, require the same normalized email as well. Date of birth is
     populated on 168 of 168 camp participants, so this is the strong path in practice, even though
     only 18 of 50 camps set `collect_dob`.
   - **Guardian** — same normalized email and same normalized last name. Allow an edit distance of
     one on the first name, which catches a typo but not "Bob" against "Robert".
   - **Emergency contact** — same normalized full name and same normalized phone. An
     `emergencyEmail` field does exist (the SDK type omits it), but CYC has filled it on 1 of 168
     participants, so match on it when present and fall back to name plus phone, which is all
     there usually is.
4. No match creates a new `people` row.

The matcher is deliberately reluctant. A false split makes a duplicate that staff merge in a minute.
A false merge silently attaches one family's registration to another person's record, and the data
it corrupts is medical and emergency data. When in doubt, create.

An email alone is never a match. Families share one address, so `parentGuardianEmail` and
`parentGuardianEmail_secondary` are often the same string for two different adults.

**Field updates on an existing person** fill gaps only. If `people.email` is null and the
registration has one, write it. If it already holds a value, leave it. That keeps a staff edit, and
a merge, from being overwritten by the next registration that names the same person.

**The manual merge task** is a Directus UI procedure, documented in `docs/crm-schema.md`:

1. Open the duplicate person.
2. Read the three reverse lists on the person detail page to find every row that points at them.
3. Repoint each row's person field at the person being kept.
4. Delete the duplicate.

Step 2 needs two more alias fields on `people`, alongside the `guardian_links` one that already
exists for `contacts.related_person_id` (`people-hub.ts:105`): one reversing `contacts.person_id`
and one reversing `registrations.person_id`. Alias fields add no columns.

### Schema changes

One regeneration of `packages/crm/schema.yaml` against a live instance covers all of them.

| Collection                                           | Change                                                                                                                                                             | Why                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions`                                           | add `name` (string)                                                                                                                                                | `CampSession.name`. Missing today (`schema.yaml:2248-2449`). Every report shows it.                                                  |
| `registrations`                                      | add `registered_at` (timestamp), `status` (string), `waiver_status` (string, nullable), `archived` (boolean), `clubspot_participant_id` (string, nullable, unique) | `schema.yaml:1966-2126` holds only the three foreign keys. No registration date exists anywhere in the hub.                          |
| `people`                                             | add `gender` (string, nullable), `street`, `city`, `state`, `postal_code` (string, nullable)                                                                       | Real participant fields. Verified live: `gender` and `street` are populated on 168/168 camp participants.                            |
| `people`                                             | make `last_name` nullable                                                                                                                                          | An emergency contact is one free-text name. Better than a sentinel empty string.                                                     |
| `people`                                             | add two o2m alias fields reversing `contacts.person_id` and `registrations.person_id`                                                                              | The merge procedure above.                                                                                                           |
| `medical_profiles`                                   | add `last_tetanus` (string), `weight` (integer, nullable)                                                                                                          | `Participant.medical_tetanus` is on the roster's medical tab today (`roster.ts:12`). `weight` is a real field, populated on 118/168. |
| `contacts`                                           | add `relationship_detail` (string, nullable)                                                                                                                       | `Participant.emergencyRelationship` ("Aunt"). Staff need it during a call.                                                           |
| `registration_billing`                               | new collection                                                                                                                                                     | See below.                                                                                                                           |
| `custom_field_definitions`, `custom_field_responses` | new collections                                                                                                                                                    | See below.                                                                                                                           |
| `sync_runs`, `sync_program_runs`                     | new collections                                                                                                                                                    | See above.                                                                                                                           |
| every `clubspot_*_id`                                | set `is_unique: true`                                                                                                                                              | `schema.yaml:1710` shows `is_unique: false`, against what `docs/crm-schema.md` says. Without it a bug can silently duplicate rows.   |

Mapping decisions, no schema change:

- `medical_profiles.conditions` ← `Participant.medical`, `allergies` ← `medical_allergies`,
  `medications` ← `medical_meds`.
- `medical_profiles.physician_name` ← `Participant.pcpName`, `physician_phone` ← `pcpNumber`. Both
  are real fields the SDK type omits, though CYC has barely used them (1 of 168 participants), so
  expect them null in practice.
- `medical_profiles.weight` ← `Participant.weight`, parsed from Clubspot's string to an integer.
  Drop a value that does not parse rather than storing junk; at least one row holds `"1"`.
- `programs.category` stays null. `CampAttributes` has no category field.
- `registration_entries.status` folds Clubspot's precedence: archived wins, then waitlist, then the
  registration's own status. Same rule as `contacts.ts:39`. `registrations.archived` keeps the raw
  flag as well, since billing reporting needs to tell a cancellation from a waitlist.
- A free-text name splits on the first space. First token to `first_name`, the rest to `last_name`.
  A single token goes to `last_name`.
- Clubspot carries a **second emergency contact** as well — `emergencyContact_secondary`,
  `emergencyMobile_secondary`, `emergencyRelationship_secondary`, `emergencyEmail_secondary`, none
  of them in the SDK type. `contacts.contact_order` already distinguishes them, so both map the
  same way. CYC has used the secondary set on 1 of 168 participants, so it is a correctness detail,
  not a common path.

### Billing

In scope. A separate collection, not columns on `registrations`, for the same reason
`medical_profiles` is separate (`docs/crm-schema.md`'s medical_profiles section): financial data
needs its own permission policy. The Guardian role's rules are an explicit list
(`people-hub.ts:128`), so it does not gain access to this collection by default.

**registration_billing** — one row per registration, mapping `BillingRegistrationAttributes`
(`packages/clubspot-sdk/src/types.ts:111-131`).

| Field                                                                                                                                                                                                                     | Type                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `id`                                                                                                                                                                                                                      | uuid, primary key             |
| `registration_id`                                                                                                                                                                                                         | FK to `registrations`, unique |
| `amount`, `amount_pending`, `amount_received`, `amount_refunded`, `amount_capturable`, `amount_deferred`, `deferred_amount_billed`, `discount`, `processing_fee`, `processing_passed_on`, `application_fee_amount`, `tax` | integer                       |
| `currency`                                                                                                                                                                                                                | string                        |
| `clubspot_billing_id`                                                                                                                                                                                                     | string, nullable, unique      |

**Amounts are integer cents**, stored exactly as Clubspot holds them. `registrations.ts:26-32`
divides by 100 for display only, which confirms the source unit. Integers avoid float rounding
entirely, and Postgres `integer` reaches about $21M. Formatting is a display concern, so set the
Directus field display to currency rather than converting on write.

`cartObject`, `customer`, and `stripeAccount` are not modeled. They are Stripe plumbing, not
reporting data.

This changes `docs/crm-schema.md`, which currently says billing stays out of scope. Update that
section rather than leaving the doc contradicting the schema.

### Custom fields, weight, and school

Checked against live CYC data (50 camps, 168 camp participants) rather than inferred from the SDK
types. Two of this section's original claims were wrong.

**Weight is a real `Participant` field, not a custom field.** `weight` is populated on 118 of 168
participants, as a numeric _string_ (`"105"`, and at least one junk `"1"`). The SDK's
`ParticipantAttributes` simply never listed it. `Camp.collect_weight` is true for 6 of 50 camps,
which matches. It maps to a field on the CRM, not through the custom-field machinery.

**School is a custom field**, and the most common one: 24 camps carry a `text` field named exactly
`School`.

`CustomField`'s real attributes, read off the live API:

| Attribute              | Notes                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `name`                 | the label — not `label`. Can be thousands of characters (one is |
|                        | an entire code of conduct), so the CRM column must be `text`    |
| `type`                 | `text`, `select`, `radio`, `file_upload`                        |
| `required`             | boolean                                                         |
| `archived`             | boolean                                                         |
| `allClasses`           | boolean; when false, `campClassesArray` scopes it               |
| `campObject`           | pointer to the camp that owns it                                |
| `clubObject`           | pointer                                                         |
| `hide_from_member`     | boolean                                                         |
| `dropdownOptionsArray` | pointers to `customFieldOptions`, for `select` and `radio`      |
| `cloned_from`          | pointer to the `customFields` row this was cloned from          |

`customFieldOptions` is a further class, not registered in the SDK at all.

The response shape also carries a field the SDK type omits:
`{ customFieldID, response, optionObjectID? }` — `optionObjectID` is present for `select` and
`radio` answers and points at the chosen `customFieldOptions` row.

**A definition is per camp, not per club.** "School" exists as 24 distinct `objectId`s linked by
`cloned_from`, and the labels drift across clones ("Race / Ethnicity" on 22 camps, "Race/Ethnicity"
on 6). So `custom_field_definitions` is keyed per camp and joined to `programs`; grouping the same
logical question across camps is a reporting concern, not a sync one, and is not solved here.

Model responses as two collections, not a JSON blob:

**custom_field_definitions** — `id`, `program_id` (FK to `programs`), `label` (text), `field_type`,
`required` (boolean), `clubspot_custom_field_id` (unique).

**custom_field_responses** — `id`, `registration_id` (FK to `registrations`), `definition_id` (FK
to `custom_field_definitions`), `value` (text).

A JSON blob on `registrations` would be cheaper to write and useless to read. Directus cannot
filter, sort, or display inside one without a custom interface, and the reason to capture school at
all is to put it on a roster and filter by it.

`customFieldOptions` is not modeled. `response` already holds the chosen option's text, so the
option rows would add a join without adding an answer.

### Authentication to Directus

The job authenticates with a Directus static token held by a machine user.

1. `randomSecret("clubspot-sync-directus-token")` in `directus.ts` generates the value and stores
   it in Secret Manager.
2. `DirectusUser` gains an optional `token` input. It provisions OIDC users only today — `provider`
   and `external_identifier`, no password and no token
   (`packages/infrastructure/src/infrastructure/directus.ts:362-376`). The provider passes `token`
   through on create and update. The machine user uses `provider: "default"` and no external
   identifier.
3. Pulumi passes the generated value straight into the resource. No read back from Secret Manager
   is needed. Reading a secret value at apply time is precedented (`people-hub.ts:42`), but this
   case avoids it.
4. The Cloud Run job reads the secret through `secretKeyRef`, the same shape as
   `run-reports-job.ts:80`. The job's service account gets `secret.grant(...)`.

A new `DirectusRole` "Clubspot Sync" holds least privilege at the Directus layer: `appAccess:
false`, create and read and update on the collections it writes, create on `sync_runs` and
`sync_program_runs`, and no delete anywhere. The sync never deletes a row. It sets
`status = cancelled`. The role needs no permission filters, so it needs no Directus license
feature.

### GCP identity

A new `clubspot-sync` service account in `packages/infrastructure/src/bootstrap/`, beside
`report-runner.ts`. It reads `clubspot-username`, `clubspot-password`, and the Directus token, and
holds `run.invoker` on its own job. Use `humanDeployer` from `config.ts:19` for the impersonation
grant rather than hardcoding an address the way `bootstrap/report-runner.ts:10` does. Identities
live in the bootstrap stack, so this needs `just deploy-bootstrap` before `just deploy`.

### What happens to the five existing reports

No hard cutover. The sync writes to a different destination, so both can run. A row in the
"Reports" worksheet is retired by a human setting `enabled` to false. No code change, no deploy.

| Report          | Outcome                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participants`  | Replaced. Retire once the hub holds the same data.                                                                                                                            |
| `contacts`      | Replaced. Retire after the work that reads that worksheet moves to the CRM.                                                                                                   |
| `registrations` | Replaced, billing included.                                                                                                                                                   |
| `camps`         | Data replaced by `programs`. The worksheet also holds registration and entry-list links, which are derivable from `clubspot_camp_id`. Retire once a Directus view shows them. |
| `sessions`      | Underlying rows replaced. The capacity view is a Directus Insights panel nobody has built. Filed as its own issue. Keep the worksheet until it exists.                        |

The reports send a Google Chat message per registration (`participants.ts:183`,
`registrations.ts:106`). The sync sends none. Staff who want those messages keep the report rows
enabled until the notifications issue is done.

### Verification

Unit tests follow `packages/gsuite/test/spreadsheet.test.ts` and the two models already in the
repo. `packages/infrastructure/test/directus-client.test.ts` stubs `fetch`.
`packages/admin-functions/test/roster.test.ts` builds fake Parse objects with an `id` and a `get`.
Both apply here. Cover the match rules for all three kinds of person, the fill-gaps-only update
rule, the name split, status precedence, `allClasses` expansion, billing and custom-field mapping,
the change-detection decision including the 24-hour refresh floor, per-camp watermark selection
from the log, and the create and update plan for a given set of existing rows.

Local: run `directus/directus:12.3.1` (the pinned version,
`packages/substrate/deploy/docker-compose.yml:60`) and Postgres in containers, apply `schema.yaml`,
then run the CLI against it with real Clubspot credentials. Clubspot reads are read-only, so this
is safe.

Live: the CLI takes `--dry-run`, which logs the planned writes and writes nothing. `main.ts:25`
already carries that TODO. The first production run is a dry run. Then run once for real against
one finished camp with `--camp <id>`, check it in the Directus UI, then let the scheduler take
over. The hub holds no Clubspot data today, so a bad run is recoverable by deleting rows, and
Directus revisions record every write.

## Alternatives

- **Add a subcommand to `admin-functions` and reuse the existing image.** Saves a Dockerfile target
  and an image build. Rejected: it ties the sync to `googleapis` and `google-spreadsheet`, and the
  two jobs then share a failure surface.
- **Reuse the `report-runner` service account.** Saves a bootstrap apply. Rejected: it would let
  the reports job write to the CRM.
- **Keep the old Pulumi resource names, or carry `pulumi.Alias` on the renamed ones.** Avoids the
  delete and recreate of the three roles. Rejected: the CRM holds no data and no hand-assigned
  users, so there is nothing for the alias to protect.
- **Custom fields as a JSON blob on `registrations`.** Cheaper to write. Rejected: Directus cannot
  filter, sort, or display inside it, which defeats the reason for capturing weight and school.
- **Billing as columns on `registrations`.** One less collection. Rejected: it would put financial
  data under the same permission rule as the registration itself.
- **Extract a shared `packages/directus` client for the sync and the Pulumi resources.** Right
  eventually. Not now: it widens the diff into the deployment path to save about 40 lines.

## Deferred to their own issues

- **#123** — a Directus Insights panel for session capacity, replacing the `sessions` report.
- **#122** — notifications for the sync: which package `notifications.ts` belongs in (`commodore`
  is not it), whether per-registration Chat messages carry over, and where the webhook URL is
  configured. Blocks nothing here; the sync ships without notifications.

## Steps

One pull request. Each step is one commit and can be reverted on its own.

1. Rename `people-hub` to `crm`: the package, the doc, the infrastructure file, the prose, and the
   five Pulumi resource names. `just preview` will show the three Directus roles and the one user
   recreated; that is expected.
2. Reverse-engineer the `customFields` Parse class and type it in `packages/clubspot-sdk`.
3. Apply the schema changes to a local Directus instance, regenerate `packages/crm/schema.yaml`
   from it, and update `docs/crm-schema.md` — including the billing section, the person-identity
   section, and the manual-merge procedure.
4. Create `packages/clubspot-sync` with the Directus REST client and its unit tests.
5. Add camp discovery, change detection, the refresh floor, and the sync log with per-camp
   watermarks, with unit tests.
6. Add the schedule mapping and reconcile plan — `programs`, `sessions`, `classes`,
   `session_classes`, `entry_caps` — with unit tests.
7. Add person matching and the person mapping — `people`, `contacts`, `medical_profiles` — with
   unit tests.
8. Add the registration mapping — `registrations`, `registration_entries`, `registration_billing`,
   `custom_field_responses` — including cancellation of vanished entries, with unit tests.
9. Add the CLI: `--dry-run`, `--camp <id>`, and the run loop.
10. Infrastructure: the `clubspot-sync` service account in the bootstrap stack, the Directus token
    secret, the `token` input on `DirectusUser`, the sync role and machine user, the Dockerfile
    target, the image, the Cloud Run job, and the Scheduler trigger.
11. Deploy, run a dry run, then sync one camp for real and check the result.
12. Write `packages/clubspot-sync/README.md` and update the package list and dependency graph in
    `CLAUDE.md`.

Twelve commits is a large pull request but a coherent one, and nothing in it is separable without
leaving a half-built schema in production: steps 3 through 9 all depend on the same schema
regeneration, and reviewing them apart from it would be harder, not easier. The two steps that
could ship alone are 1 (the rename) and 2 (the SDK class). Keep them first so they can be applied
early if the rest of the review takes a while.

One risk worth naming: step 1 recreates the Directus roles and the staff user. Run `just deploy`
on the branch soon after that commit rather than at the end, so a surprise in the recreate shows up
on day one instead of under the rest of the diff.

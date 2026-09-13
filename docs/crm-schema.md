---
tags: [architecture, crm, directus]
---

## CRM: schema and permission model

Design doc for the Directus data model behind Layer 2 of `docs/architecture.md` (the CRM), per the
plan agreed on issue #69. Covers the collections, fields, and permission policies;
deployment and rollout are tracked in the sibling issues (#92-#95) that decompose #69.

### Scope and non-goals

- Models what Clubspot actually gives us: people, their guardian/emergency-contact relationships,
  the camp schedule (programs/sessions/classes/capacity), registrations, and billing. No household
  grouping — Clubspot has no concept of a household, only per-registration guardians and emergency
  contacts, so that's what the schema keys off.
- Terminology matches Clubspot and the website: **program** (Clubspot's `Camp`), **session**
  (`CampSession`), **class** (`CampClass`), **registration** (`Registration`/`RegistrationCampSession`)
  — not "enrollment."
- Registration status and person contact fields get **history, not just a current value** — see
  [Change tracking and provenance](#change-tracking-and-provenance).
- Person identity is resolved once, at creation, and never re-resolved — see
  [Person identity and merging](#person-identity-and-merging).
- Auth identity is deliberately separate from person data — see [Auth identity](#auth-identity)
  below.
- Coach and guardian **portals** (thin clients calling this API) are out of scope; this doc defines
  the roles/policies they'll eventually use, but nothing here provisions their logins. That's #65.

### Collections

**people** — one row per human known to the org: staff, coaches, guardians, participants, emergency
contacts. Roles aren't stored — they're derived from relationships: staff from `directus_user_id` +
Directus role, coach from an `event_staff` row, guardian/emergency contact from a `contacts` row,
participant from a `registrations` row (see [Collections](#collections) below).

Still no `clubspot_id` here — Clubspot has no stable person record of its own. Instead,
`contacts.person_id` and `registrations.person_id` each point at a `people` row, resolved once when
that row is created; see [Person identity and merging](#person-identity-and-merging) for how a
match is found and how staff undo a bad one.

| Field                                    | Type                                              | Notes                                                                                                    |
| ---------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                                     | uuid                                              | primary key                                                                                              |
| `first_name`                             | string                                            |                                                                                                          |
| `last_name`                              | string, nullable                                  | an emergency contact can be one free-text name with no surname                                           |
| `email`, `phone`                         | string, nullable                                  | contact info, not auth                                                                                   |
| `date_of_birth`                          | date, nullable                                    | required for minors                                                                                      |
| `gender`                                 | string, nullable                                  |                                                                                                          |
| `street`, `city`, `state`, `postal_code` | string, nullable                                  |                                                                                                          |
| `directus_user_id`                       | uuid, nullable, unique, FK -> `directus_users.id` | see [Auth identity](#auth-identity)                                                                      |
| `guardian_links`                         | alias (o2m)                                       | reverse of `contacts.related_person_id` — the contacts rows where this person is the minor               |
| `contact_links`                          | alias (o2m)                                       | reverse of `contacts.person_id` — the contacts rows where this person is a guardian or emergency contact |
| `registration_links`                     | alias (o2m)                                       | reverse of `registrations.person_id` — the registrations rows where this person is the participant       |

The three alias fields add no column. They're how staff find every row that points at a person
before merging a duplicate — see [Person identity and merging](#person-identity-and-merging).

**medical_profiles** — one-to-one with `people`, kept as its own collection so its permission policy
can be stricter than a roster-level `people` read (allergies, medications, conditions, physician
contact).

| Field                                    | Type                            | Notes                                                                                          |
| ---------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                     | uuid, PK                        | own primary key — see note                                                                     |
| `person_id`                              | uuid, FK -> `people.id`, unique | one profile per person                                                                         |
| `allergies`, `medications`, `conditions` | text                            | free-form                                                                                      |
| `physician_name`, `physician_phone`      | string, nullable                |                                                                                                |
| `last_tetanus`                           | string, nullable                | Clubspot's `Participant.medical_tetanus`                                                       |
| `weight`                                 | integer, nullable               | Clubspot sends a numeric string (e.g. `"105"`); the sync parses it and drops values that don't |

Originally specced as `person_id` doubling as the primary key (no separate `id`) — reverted while
building the real schema snapshot: Directus's relations API refuses to attach a relation to a field
flagged as a collection's primary key. A normal auto `id` plus a unique `person_id` FK is the
standard way Directus does 1:1s, so that's what's actually applied.

**contacts** — one join collection for both relationship kinds Clubspot gives us (guardian and
emergency contact), rather than a separate table per type, since the shape is identical. Other
relationship kinds, if they're ever needed, get their own dedicated table rather than growing this
one's `relationship_type` enum.

Like `people`, these rows have no Clubspot id of their own to key off — Clubspot doesn't model a
guardian/emergency contact as a linked record, just flat strings on the participant
(`parentGuardianName`/`_secondary`, `emergencyContact`/`emergencyRelationship`). `contact_order`
is what recovers Clubspot's primary-vs-secondary guardian distinction once the sync turns those flat
fields into rows here.

| Field                 | Type                                   | Notes                                                       |
| --------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `id`                  | uuid                                   | primary key                                                 |
| `related_person_id`   | uuid, FK -> `people.id`                | the minor                                                   |
| `person_id`           | uuid, FK -> `people.id`                | the guardian or emergency contact                           |
| `relationship_type`   | enum (`guardian`, `emergency_contact`) |                                                             |
| `contact_order`       | integer                                | call order when a minor has more than one                   |
| `relationship_detail` | string, nullable                       | free text, e.g. "Aunt" (Clubspot's `emergencyRelationship`) |

**event_staff** — coach/staff assigned to a session. This is the row that makes someone a "coach"
(derived, not stored on `people`) — not used to scope roster permissions yet, see
[Permission model](#permission-model).

| Field        | Type                      | Notes       |
| ------------ | ------------------------- | ----------- |
| `id`         | uuid                      | primary key |
| `person_id`  | uuid, FK -> `people.id`   |             |
| `session_id` | uuid, FK -> `sessions.id` |             |

**programs** — matches org/Clubspot terminology: a program is what CYC calls a `Camp` in Clubspot
(e.g. "Youth Camp", "LTS Weekday", "ILCA Race Team") — the thing on the website you sign up for.

| Field              | Type                     | Notes                                                                          |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------ |
| `id`               | uuid                     | primary key                                                                    |
| `name`             | string                   |                                                                                |
| `category`         | string, nullable         | Clubspot's own grouping (e.g. "Summer Camp", "Junior Racing", "Adult Sailing") |
| `clubspot_camp_id` | string, nullable, unique | dedup key for the sync                                                         |

**sessions** — a dated instance of a program (Clubspot's `CampSession`).

| Field                    | Type                      | Notes                         |
| ------------------------ | ------------------------- | ----------------------------- |
| `id`                     | uuid                      | primary key                   |
| `program_id`             | uuid, FK -> `programs.id` |                               |
| `name`                   | string                    | Clubspot's `CampSession.name` |
| `start_date`, `end_date` | date                      |                               |
| `clubspot_session_id`    | string, nullable, unique  | dedup key for the sync        |

**classes** — an age/skill subdivision within a program (Clubspot's `CampClass`, e.g. "Beginner" vs.
"Advanced"). Each registration entry is for a specific session _and_ class — see
`registration_entries` below.

| Field               | Type                      | Notes                                                                  |
| ------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `id`                | uuid                      | primary key                                                            |
| `program_id`        | uuid, FK -> `programs.id` | a class belongs to the program, independent of which sessions offer it |
| `name`              | string                    |                                                                        |
| `clubspot_class_id` | string, nullable, unique  | dedup key for the sync                                                 |

**session_classes** — which classes a session actually offers, i.e. the camp schedule itself. A
pure join, no fields of its own. Denormalized: Clubspot represents this as either an explicit
`CampSession.campClassesArray` or an `allClasses` flag meaning "every class in the program" — the
sync expands the `allClasses` case into one row per program class at sync time, so this table always
holds the actual explicit list and nothing downstream needs to special-case the flag. No Clubspot id
of its own — it's an array (or a flag) on `CampSession`, not a separate object — so the sync just
reconciles rows to match Clubspot's current state each run (remove rows no longer present, add new
ones).

| Field        | Type                      | Notes       |
| ------------ | ------------------------- | ----------- |
| `id`         | uuid                      | primary key |
| `session_id` | uuid, FK -> `sessions.id` |             |
| `class_id`   | uuid, FK -> `classes.id`  |             |

**entry_caps** — capacity, matching Clubspot's `EntryCap` exactly: a cap on one class, either
overall (`session_id` null, applies across every session) or for one specific session.

| Field                   | Type                                | Notes                                            |
| ----------------------- | ----------------------------------- | ------------------------------------------------ |
| `id`                    | uuid                                | primary key                                      |
| `class_id`              | uuid, FK -> `classes.id`            |                                                  |
| `session_id`            | uuid, FK -> `sessions.id`, nullable | null = applies to this class across all sessions |
| `cap`                   | integer                             | the actual limit (Clubspot's own field name)     |
| `clubspot_entry_cap_id` | string, nullable, unique            | dedup key for the sync                           |

This — `programs` / `sessions` / `classes` / `session_classes` / `entry_caps` — is the camp
schedule: worth capturing accurately from the sync's first pass rather than backfilling later, since
the website and the eventual financial-model app both need it, not just rosters/permissions.

**registrations** — one row per Clubspot `Registration` object: a participant's signup for a
program (Clubspot's own term — matched here rather than "enrollment"). This is the parent; a single
registration can cover multiple sessions/classes (a multi-week camp signup), which is what
`registration_entries` below is for. Billing is a separate collection, `registration_billing`
below, so its own permission policy can differ from the registration record.

| Field                      | Type                      | Notes                                                                                                                         |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid                      | primary key                                                                                                                   |
| `person_id`                | uuid, FK -> `people.id`   | the participant                                                                                                               |
| `program_id`               | uuid, FK -> `programs.id` |                                                                                                                               |
| `registered_at`            | timestamp                 | when the registration was made                                                                                                |
| `status`                   | string                    | Clubspot's own `Registration.status`, before the archived/waitlist precedence folded into `registration_entries.status` below |
| `waiver_status`            | string, nullable          |                                                                                                                               |
| `archived`                 | boolean                   | Clubspot's raw archived flag, kept alongside `status` so billing reporting can tell a cancellation from a waitlist            |
| `clubspot_registration_id` | string, nullable, unique  | dedup key for the sync                                                                                                        |
| `clubspot_participant_id`  | string, nullable, unique  | dedup key for the sync                                                                                                        |

**registration_entries** — one row per session + class within a registration (Clubspot's
`RegistrationCampSession` — "Session Join Id" in the existing `ParticipantsReport`). A registration
spanning multiple weeks/classes becomes multiple entries here, matching what the current spreadsheet
already does.

| Field                      | Type                                        | Notes                                                                                                                            |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid                                        | primary key                                                                                                                      |
| `registration_id`          | uuid, FK -> `registrations.id`              |                                                                                                                                  |
| `session_id`               | uuid, FK -> `sessions.id`                   |                                                                                                                                  |
| `class_id`                 | uuid, FK -> `classes.id`                    |                                                                                                                                  |
| `status`                   | enum (`confirmed`, `waitlist`, `cancelled`) | same vocabulary as #60; the _current_ status — see [Change tracking and provenance](#change-tracking-and-provenance) for history |
| `clubspot_session_join_id` | string, nullable, unique                    | dedup key for the sync (`RegistrationCampSession`'s own id)                                                                      |

**registration_billing** — one row per registration, mapping Clubspot's
`BillingRegistrationAttributes`. Its own collection, not columns on `registrations`, for the same
reason `medical_profiles` is separate: financial data needs its own permission policy. The Guardian
role's rules are an explicit list, so it doesn't gain access to this collection by default.

Amounts are integer cents, stored exactly as Clubspot holds them — Postgres `integer` reaches about
$21M, and integers avoid float rounding entirely. Formatting into dollars is a display concern, not
a storage one.

| Field                                                                                                                                                                                                                     | Type                                   | Notes                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------- |
| `id`                                                                                                                                                                                                                      | uuid                                   | primary key                      |
| `registration_id`                                                                                                                                                                                                         | uuid, FK -> `registrations.id`, unique | one billing row per registration |
| `amount`, `amount_pending`, `amount_received`, `amount_refunded`, `amount_capturable`, `amount_deferred`, `deferred_amount_billed`, `discount`, `processing_fee`, `processing_passed_on`, `application_fee_amount`, `tax` | integer                                | cents                            |
| `currency`                                                                                                                                                                                                                | string                                 |                                  |
| `clubspot_billing_id`                                                                                                                                                                                                     | string, nullable, unique               | dedup key for the sync           |

`cartObject`, `customer`, and `stripeAccount` from Clubspot's billing object are Stripe plumbing, not
reporting data, and aren't modeled.

Clubspot lets each camp define its own extra questions (Clubspot's `CustomField`, e.g. "School",
"Race/Ethnicity"). A definition belongs to one camp, not the club as a whole — the same logical
question gets cloned per camp and can drift in wording between clones, so grouping the same question
across camps is a reporting concern this schema doesn't try to solve.

**custom_field_definitions**

| Field                      | Type                      | Notes                                                                                       |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                       | uuid                      | primary key                                                                                 |
| `program_id`               | uuid, FK -> `programs.id` |                                                                                             |
| `label`                    | text                      | Clubspot's `CustomField.name` — not bounded; one live label runs to thousands of characters |
| `field_type`               | string                    | Clubspot's `CustomField.type`: `text`, `select`, `radio`, or `file_upload`                  |
| `required`                 | boolean                   |                                                                                             |
| `clubspot_custom_field_id` | string, nullable, unique  | dedup key for the sync                                                                      |

**custom_field_responses** — one row per registration's answer to a definition. A JSON blob on
`registrations` would be cheaper to write and useless to read: Directus can't filter, sort, or
display inside one, which defeats the reason for capturing weight and school in the first place.

| Field             | Type                                      | Notes                                                                                                                          |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | uuid                                      | primary key                                                                                                                    |
| `registration_id` | uuid, FK -> `registrations.id`            |                                                                                                                                |
| `definition_id`   | uuid, FK -> `custom_field_definitions.id` |                                                                                                                                |
| `value`           | text                                      | the answer; for `select`/`radio` this already holds the chosen option's text, so `customFieldOptions` isn't modeled separately |

Weight is not a custom field, even though `Camp.collect_weight` looks like one — it's a real
`Participant` attribute the SDK's type omitted. It lives on `medical_profiles.weight` above, not
here.

`sync_runs` and `sync_program_runs` are config/telemetry for the clubspot-sync job, not CRM data.
They live in this same schema file because it's the one schema Pulumi applies to the shared Directus
instance — a second schema file for two log tables would just duplicate the apply machinery.

**sync_runs** — one row per job execution.

| Field                                 | Notes                                  |
| ------------------------------------- | -------------------------------------- |
| `id`                                  | primary key                            |
| `started_at`                          | timestamp, set at the start of the run |
| `finished_at`                         | timestamp, nullable until the run ends |
| `status`                              | enum (`running`, `ok`, `failed`)       |
| `programs_checked`, `programs_synced` | integer                                |
| `error`                               | text, nullable                         |

**sync_program_runs** — one row per camp a run touched.

| Field                            | Notes                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | primary key                                                                                                                     |
| `run_id`                         | FK to `sync_runs`                                                                                                               |
| `program_id`                     | FK to `programs`, nullable on the first sync of a camp                                                                          |
| `clubspot_camp_id`               | string, not unique — many rows share a camp across runs, but it identifies a failed first sync before any `programs` row exists |
| `started_at`, `finished_at`      | timestamp                                                                                                                       |
| `status`                         | enum (`ok`, `failed`, `skipped`)                                                                                                |
| `items_created`, `items_updated` | integer                                                                                                                         |
| `error`                          | text, nullable                                                                                                                  |

The watermark for a camp's next sync is the greatest `started_at` among that camp's
`sync_program_runs` rows with `status = ok`, not a run-level watermark — a run-level one would
advance past a camp that failed while others in the same run succeeded.

### Person identity and merging

`contacts.person_id` and `registrations.person_id` are resolved **once, when the row is created**,
and never re-resolved. A later sync run leaves an existing row's `person_id` alone — that's what
makes a manual merge (below) durable: nothing undoes it on the next run.

**Matching a new row to an existing person.** Directus's REST filters give only `_eq` and
`_icontains`, so "fuzzy" means: normalize the incoming data, fetch a small candidate set with an
indexable filter, then compare in the client.

- **Participant** — same normalized first and last name, and the same date of birth. Without a date
  of birth, also require the same normalized email.
- **Guardian** — same normalized email and last name, allowing one character of edit distance on
  the first name.
- **Emergency contact** — same normalized full name and phone, or the same email when Clubspot has
  one.

An email alone is never a match — families share one address across two different adults. No match
creates a new `people` row. The matcher is deliberately reluctant: a false split just makes a
duplicate staff merge in a minute, but a false merge silently attaches one family's registration to
another person's medical and emergency data.

Updating an existing person fills gaps only: if `people.email` is null and a registration supplies
one, the sync writes it; if it already holds a value, the sync leaves it. That way a staff edit, or
a merge, survives the next registration that names the same person.

**Merging a duplicate** is a Directus UI procedure:

1. Open the duplicate person.
2. Read `guardian_links`, `contact_links`, and `registration_links` on their detail page to find
   every row that points at them.
3. Repoint each row's person field at the person being kept.
4. Delete the duplicate.

### Change tracking and provenance

Directus already does this: every API-driven create/update/delete is logged in `directus_activity`
(who, when, on what) with a paired `directus_revisions` row holding the full item snapshot and a
delta — for every collection, no opt-in needed. Architecture.md already assumed this
(`Audit — Directus activity log for data access/changes`), so there's no need for bespoke history
tables here, as long as the sync always writes through the Directus API (never raw SQL):

- **Registration status** (waitlist → confirmed → cancelled) doesn't need its own event log — the
  revision history on a `registration_entries` row already shows every state it's been in and when
  Directus recorded each change. If Clubspot's own historical timestamps
  (`RegistrationCampSession.waitlist_updates`) matter and not just "when we noticed," the sync's
  first import of a registration can replay each transition as its own sequential write so the
  revision _order_ matches reality — though the revision _timestamp_ is always "when Directus saw
  the write," not the original Clubspot moment; a backfill can't inject history at an arbitrary past
  time.
- **Person contact-field changes** (a guardian's email changing between registrations two years
  apart) are the same story: the revision history on a `people` row already shows every value
  `email`/`phone`/`first_name`/`last_name` has held. Confirmed by looking at the live participants
  spreadsheet (the thing the sync replaces) — it's a fully-rebuilt-every-run flat snapshot with no
  timestamp or version on any row today, which is the actual gap here, and Directus's activity log
  closes it without any schema of our own.

**What the activity log doesn't give us:** a revision is attributed to the Directus user who made
the write — for the sync's automated updates that's always its own service account, not _which
registration_ supplied a given value. No dedicated pointer for that here: `registrations.person_id`
already gives every registration a person touched, so "which one most recently supplied this email"
is a join against that plus the revision timestamps, not a separate FK on `people`. That join is
untested against real staff workflows; revisit if it turns out too awkward to actually use.

### Auth identity

Auth info does not live on `people`. Directus already has its own identity table — `directus_users`
— with roles, policies, and OIDC `provider`/`external_identifier` fields for linking a Google login.
Reusing it instead of a homegrown field means:

- `people.directus_user_id` is a nullable, unique FK to `directus_users.id`. Set only for people who
  have an actual login: staff now (provisioned directly by an admin); coach/guardian later, once
  #65's account-linking flow provisions or links a `directus_users` row on first OIDC login.
- Directus's own OIDC config does the email-matching (`provider` + `external_identifier` on
  `directus_users`). This schema has no identity/matching logic of its own — it only points `people`
  at the resulting user once one exists.

### Permission model

- **Administrator** — Directus's built-in full-access role.
- **Staff** — authenticates via Directus's native Google OIDC, restricted to Workspace accounts an
  admin has provisioned as Directus users. Full read/write on every collection above, including
  `medical_profiles`. The only role delivered end-to-end by #69/#92-#95.
- **Coach** — defined now so the schema doesn't need reshaping later, but has no way to log in yet
  (needs #65). KISS for now: any authenticated Directus user can read `sessions` /
  `registration_entries` / `people` roster fields (no `medical_profiles`) — scoping a coach to only
  their own sessions via `event_staff` is a follow-up, not built here.
- **Guardian** — same login caveat as Coach. Policy: read their own minors' `people` /
  `medical_profiles` / `registrations` / `registration_entries`, filtered through `contacts` where
  `relationship_type == 'guardian'`. This scoping isn't KISS'd away like the coach roster case above
  — it's the medical-data boundary the whole design doc exists to get right. Collection-level
  permissions are what's built; whether `medical_profiles` needs field-level restrictions too is a
  question for whenever a Guardian actually logs in (#65), not settled here.
- **Emergency contacts get no role or login.** They're informational rows staff can see on a minor's
  record (`contacts` where `relationship_type == 'emergency_contact'`), not a portal audience.

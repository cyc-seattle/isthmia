---
tags: [architecture, people-hub, directus]
---

## People hub: schema and permission model

Design doc for the Directus data model behind Layer 2 of `docs/architecture.md` (the CRM / people
hub), per the plan agreed on issue #69. Covers the collections, fields, and permission policies;
deployment and rollout are tracked in the sibling issues (#92-#95) that decompose #69.

### Scope and non-goals

- Models what Clubspot actually gives us: people, their guardian/emergency-contact relationships,
  the camp schedule (programs/sessions/classes/capacity), and registrations. No household
  grouping — Clubspot has no concept of a household, only per-registration guardians and emergency
  contacts, so that's what the schema keys off.
- Terminology matches Clubspot and the website: **program** (Clubspot's `Camp`), **session**
  (`CampSession`), **class** (`CampClass`), **registration** (`Registration`/`RegistrationCampSession`)
  — not "enrollment."
- Registration status and person contact fields get **history, not just a current value** — see
  [Change tracking and provenance](#change-tracking-and-provenance).
- Auth identity is deliberately separate from person data — see [Auth identity](#auth-identity)
  below.
- Coach and guardian **portals** (thin clients calling this API) are out of scope; this doc defines
  the roles/policies they'll eventually use, but nothing here provisions their logins. That's #65.

### Collections

**people** — one row per human known to the org: staff, coaches, guardians, participants, emergency
contacts. Roles aren't stored — they're derived from relationships: staff from `directus_user_id` +
Directus role, coach from an `event_staff` row, guardian/emergency contact from a `contacts` row,
participant from a `registrations` row.

No `clubspot_id` here. Clubspot has no stable person record — each registration carries its own
contact data, and one real person can show up as the contact on many registrations. Deduplicating
and collecting those into a single `people` row (by email, most likely) is the identity-resolution
problem #70's sync has to solve; it isn't a field this schema can just copy in.

| Field                     | Type                                              | Notes                               |
| ------------------------- | ------------------------------------------------- | ----------------------------------- |
| `id`                      | uuid                                              | primary key                         |
| `first_name`, `last_name` | string                                            |                                     |
| `email`, `phone`          | string, nullable                                  | contact info, not auth              |
| `date_of_birth`           | date, nullable                                    | required for minors                 |
| `directus_user_id`        | uuid, nullable, unique, FK -> `directus_users.id` | see [Auth identity](#auth-identity) |

**medical_profiles** — one-to-one with `people`, kept as its own collection so its permission policy
can be stricter than a roster-level `people` read (allergies, medications, conditions, physician
contact).

| Field                                    | Type                        | Notes                                             |
| ---------------------------------------- | --------------------------- | ------------------------------------------------- |
| `person_id`                              | uuid, PK, FK -> `people.id` | one profile per person, so `person_id` is the key |
| `allergies`, `medications`, `conditions` | text                        | free-form                                         |
| `physician_name`, `physician_phone`      | string, nullable            |                                                   |

**contacts** — one join collection for both relationship kinds Clubspot gives us (guardian and
emergency contact), rather than a separate table per type, since the shape is identical. Other
relationship kinds, if they're ever needed, get their own dedicated table rather than growing this
one's `relationship_type` enum.

Like `people`, these rows have no Clubspot id of their own to key off — Clubspot doesn't model a
guardian/emergency contact as a linked record, just flat strings on the participant
(`parentGuardianName`/`_secondary`, `emergencyContact`/`emergencyRelationship`). `contact_order`
is what recovers Clubspot's primary-vs-secondary guardian distinction once #70 turns those flat
fields into rows here.

| Field               | Type                                   | Notes                                     |
| ------------------- | -------------------------------------- | ----------------------------------------- |
| `id`                | uuid                                   | primary key                               |
| `related_person_id` | uuid, FK -> `people.id`                | the minor                                 |
| `person_id`         | uuid, FK -> `people.id`                | the guardian or emergency contact         |
| `relationship_type` | enum (`guardian`, `emergency_contact`) |                                           |
| `contact_order`     | integer                                | call order when a minor has more than one |

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
| `clubspot_camp_id` | string, nullable, unique | dedup key for #70                                                              |

**sessions** — a dated instance of a program (Clubspot's `CampSession`).

| Field                    | Type                      | Notes                                                                                                          |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                     | uuid                      | primary key                                                                                                    |
| `program_id`             | uuid, FK -> `programs.id` |                                                                                                                |
| `start_date`, `end_date` | date                      |                                                                                                                |
| `all_classes`            | boolean                   | this session offers every class in the program, rather than a specific list (Clubspot's own `allClasses` flag) |
| `clubspot_session_id`    | string, nullable, unique  | dedup key for #70                                                                                              |

**classes** — an age/skill subdivision within a program (Clubspot's `CampClass`, e.g. "Beginner" vs.
"Advanced"). A registration is for a specific session _and_ class — see `registrations` below.

| Field               | Type                      | Notes                                                                  |
| ------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `id`                | uuid                      | primary key                                                            |
| `program_id`        | uuid, FK -> `programs.id` | a class belongs to the program, independent of which sessions offer it |
| `name`              | string                    |                                                                        |
| `clubspot_class_id` | string, nullable, unique  | dedup key for #70                                                      |

**session_classes** — which classes a session actually offers (Clubspot's
`CampSession.campClassesArray`), i.e. the camp schedule itself. A pure join, no fields of its own;
irrelevant for a session where `sessions.all_classes` is true (every program class applies). No
Clubspot id of its own — it's an array on `CampSession`, not a separate object — so #70 just
reconciles it to match Clubspot's array each sync (remove rows no longer present, add new ones).

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
| `clubspot_entry_cap_id` | string, nullable, unique            | dedup key for #70                                |

This — `programs` / `sessions` / `classes` / `session_classes` / `entry_caps` — is the camp
schedule: worth capturing accurately from #70's first sync rather than backfilling later, since the
website and the eventual financial-model app both need it, not just rosters/permissions.

**registrations** — a participant's registration for one session + class (Clubspot's own term —
matched here rather than "enrollment"). This is deliberately at Clubspot's finest grain, its
`RegistrationCampSession` join ("Session Join Id" in the existing `ParticipantsReport`) rather than
its parent `Registration` object: a single Clubspot registration spanning multiple weeks/classes
becomes multiple rows here, one per session+class, matching what the current spreadsheet already
does. Billing/payment (Clubspot's `billing_registration`) stays out of scope, same as the rest of
the financial model.

| Field                      | Type                                        | Notes                                                                                                                            |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid                                        | primary key                                                                                                                      |
| `person_id`                | uuid, FK -> `people.id`                     | the participant                                                                                                                  |
| `session_id`               | uuid, FK -> `sessions.id`                   |                                                                                                                                  |
| `class_id`                 | uuid, FK -> `classes.id`                    |                                                                                                                                  |
| `status`                   | enum (`confirmed`, `waitlist`, `cancelled`) | same vocabulary as #60; the _current_ status — see [Change tracking and provenance](#change-tracking-and-provenance) for history |
| `clubspot_registration_id` | string, nullable                            | groups rows from the same parent Clubspot registration (a multi-session signup); **not unique alone**                            |
| `clubspot_session_join_id` | string, nullable, unique                    | the true per-row dedup key for #70 (`RegistrationCampSession`'s own id)                                                          |

### Change tracking and provenance

Directus already does this: every API-driven create/update/delete is logged in `directus_activity`
(who, when, on what) with a paired `directus_revisions` row holding the full item snapshot and a
delta — for every collection, no opt-in needed. Architecture.md already assumed this
(`Audit — Directus activity log for data access/changes`), so there's no need for bespoke history
tables here, as long as #70 always writes through the Directus API (never raw SQL):

- **Registration status** (waitlist → confirmed → cancelled) doesn't need its own event log — the
  revision history on a `registrations` row already shows every state it's been in and when Directus
  recorded each change. If Clubspot's own historical timestamps
  (`RegistrationCampSession.waitlist_updates`) matter and not just "when we noticed," #70's first
  import of a registration can replay each transition as its own sequential write so the revision
  _order_ matches reality — though the revision _timestamp_ is always "when Directus saw the write,"
  not the original Clubspot moment; a backfill can't inject history at an arbitrary past time.
- **Person contact-field changes** (a guardian's email changing between registrations two years
  apart) are the same story: the revision history on a `people` row already shows every value
  `email`/`phone`/`first_name`/`last_name` has held. Confirmed by looking at the live participants
  spreadsheet (the thing #70/#95 replace) — it's a fully-rebuilt-every-run flat snapshot with no
  timestamp or version on any row today, which is the actual gap here, and Directus's activity log
  closes it without any schema of our own.

**What the activity log doesn't give us:** a revision is attributed to the Directus user who made
the write — for #70's automated updates that's always the sync's own service account, not _which
registration_ supplied a given value. No dedicated pointer for that here: `registrations.person_id`
already gives every registration a person touched, so "which one most recently supplied this email"
is a join against that plus the revision timestamps, not a separate FK on `people`.

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
  (needs #65). KISS for now: any authenticated Directus user can read `sessions` / `registrations` /
  `people` roster fields (no `medical_profiles`) — scoping a coach to only their own sessions via
  `event_staff` is a follow-up, not built here.
- **Guardian** — same login caveat as Coach. Policy: read their own minors' `people` /
  `medical_profiles` / `registrations`, filtered through `contacts` where
  `relationship_type == 'guardian'`. This scoping isn't KISS'd away like the coach roster case above
  — it's the medical-data boundary the whole design doc exists to get right.
- **Emergency contacts get no role or login.** They're informational rows staff can see on a minor's
  record (`contacts` where `relationship_type == 'emergency_contact'`), not a portal audience.

### Open questions for the applying slice (#95)

- Exact Directus field types (`uuid` vs. Directus's integer PKs) for every collection above — pick
  whichever keeps the permission filters simplest when building the real schema snapshot.
- Whether `medical_profiles` needs field-level (not just collection-level) permissions before a
  Guardian role ever actually logs in.
- The actual person-dedup rule #70 will use (email match, most likely, with a manual merge path for
  the rest) — out of scope here, but the schema above assumes one exists.
- Whether contact-field provenance ever needs more than "join `registrations` on `person_id` and
  compare revision timestamps" — not built now; revisit if that join turns out too awkward for staff
  to actually use.

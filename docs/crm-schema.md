---
tags: [architecture, crm, directus]
---

## CRM: schema and permission model

Design doc for the CRM's Directus data model, per the plan agreed on issue #69. Covers person
identity, provenance, and permission policies — see `packages/crm/schema.yaml` and
`packages/clubspot/schema.yaml` for collections and fields; deployment and rollout are tracked in
the sibling issues (#92-#95) that decompose #69.

### Scope and non-goals

- Models what Clubspot actually gives us: people, their guardian/emergency-contact relationships,
  the camp schedule (camps/sessions/classes/capacity), registrations, and billing. No household
  grouping — Clubspot has no concept of a household, only per-registration guardians and emergency
  contacts, so that's what the schema keys off.
- Terminology matches Clubspot and the website. **Camp** (`camps`) is Clubspot's own `Camp` — one
  row per season, e.g. "2026 Fall Double-handed Race Team". **Program** is the durable catalog
  entry a class links to by hand, e.g. "Double-handed Race Team", the thing a Google Group or a
  volunteer role attaches to; a camp's own programs are derived — the distinct programs of its
  classes (#149). **Session** (`CampSession`), **class** (`CampClass`), and **registration**
  (`Registration`/`RegistrationCampSession`) are unchanged — not "enrollment."
- Registration status and person contact fields get **history, not just a current value** — see
  [Change tracking and provenance](#change-tracking-and-provenance).
- Person identity is resolved once, at creation, and never re-resolved — see
  [Person identity and merging](#person-identity-and-merging).
- Auth identity is deliberately separate from person data — see [Auth identity](#auth-identity)
  below.
- Coach and guardian **portals** (thin clients calling this API) are out of scope; this doc defines
  the roles/policies they'll eventually use, but nothing here provisions their logins. That's #65.

### Collections

Collections and fields are defined in `packages/crm/schema.yaml` and `packages/clubspot/schema.yaml`
— the Clubspot-shaped collections (`camps`, `sessions`, `classes`, registrations, and custom
fields) live in the latter, split out because they wouldn't survive Clubspot being replaced. Both
are the source of truth Pulumi applies to Directus as one merged snapshot. The sections below cover
identity, provenance, and permissions — behavior that isn't visible in either schema file itself.

`registration_entries` also carries five nullable columns for Clubspot's own per-entry status and
waitlist bookkeeping: `clubspot_status`, `confirmed_at`, `waitlist_number`, `accepted_from_waitlist`,
`priority`. Their field notes in `schema.yaml` cover the why. This file does not repeat it.

`programs` and `program_roles` are hand-maintained catalogs, not synced from Clubspot.
`program_role_assignments` links a person to a program with a role from that catalog — a Parent
Coordinator or Program Lead, hand-entered by staff, not derived from `event_staff` (which is
person-plus-session and Clubspot-derived). Anyone holding an assignment is simply a member of the
program's Google Group; a role's meaning carries no provider mapping.

`programs.revenue_account` is likewise hand-set by staff and never written by a sync — the finance
chart-of-accounts code a program's revenue rolls up to. `gsuite-sync`'s audit uses it to flag a
Clubspot Camp whose classes map to programs with more than one distinct account (#149).

`gsuite-sync` extends collections it doesn't own rather than owning separate ones: it declares
`programs.google_group_id` in its own schema, even though `programs` belongs to `crm`, not this
package - groups hang off programs only. Every `clubspot_*` id column, by contrast, is a plain
field declared directly in `packages/clubspot/schema.yaml`, since `clubspot-sync` owns the
collections it came from. Every package's schema is merged into one snapshot and applied together,
so a collection here can carry another package's field without this package knowing about that
provider.

### Person identity and merging

A `contacts` row links two people: `subject_id` is the person the record is about (a minor, usually
— the same person `registrations.person_id` points to), and `contact_id` is their guardian or
emergency contact. Both are resolved **once, when the row is created**, and never re-resolved. A
later sync run leaves an existing row's person field alone — that's what makes a manual merge
(below) durable: nothing undoes it on the next run.

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
2. Read `my_contacts`, `contact_for`, and `registration_links` on their detail page to find
   every row that points at them.
3. Repoint each row's person field at the person being kept.
4. Delete the duplicate.

### Change tracking and provenance

Directus already does this: every API-driven create/update/delete is logged in `directus_activity`
(who, when, on what) with a paired `directus_revisions` row holding the full item snapshot and a
delta — for every collection, no opt-in needed, so there's no need for bespoke history
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

This is row history, not run history. Which sync tasks ran, retried, or failed is tracked
separately, in `packages/directus`'s `sync_tasks` queue — infrastructure shared by every sync
package, not part of this schema.

**What the activity log doesn't give us:** a revision is attributed to the Directus user who made
the write — for the sync's automated updates that's always its own service account, not _which
registration_ supplied a given value. No dedicated pointer for that here: `registrations.person_id`
already gives every registration a person touched, so "which one most recently supplied this email"
is a join against that plus the revision timestamps, not a separate FK on `people`. That join is
untested against real staff workflows; revisit if it turns out too awkward to actually use.

### Promoted fields

`promoted_fields` maps a Clubspot custom-field question — asked per camp, so
`custom_field_definitions` has no single row for it — onto a `people` column. `school` is the only
target today; adding another means adding it to `PROMOTABLE_PERSON_FIELDS`
(`packages/clubspot/src/promoted-fields.ts`) and deploying, not editing config. Each sync run ranks
candidate responses by registration — non-archived before archived, then most recent, with a stable
tiebreak — and gap-fills the column like every other `people` scalar (#137).

The row is staff-maintained, not Pulumi-managed: applying it from `schema.yaml` would revert a
staff edit to its labels on the next deploy.

### Auth identity

Auth info does not live on `people`. Directus already has its own identity table — `directus_users`
— with roles, policies, and OIDC `provider`/`external_identifier` fields for linking a Google login.
Reusing it instead of a homegrown field means:

- `people.directus_user_id` is a nullable, unique FK to `directus_users.id`, declared in
  `packages/directus`'s schema — Directus is itself a provider, so its own identity column is an
  extension field on `people` like any other. Set only for people who have an actual login: staff
  now (provisioned directly by an admin); coach/guardian later, once #65's account-linking flow
  provisions or links a `directus_users` row on first OIDC login.
- Directus's own OIDC config does the email-matching (`provider` + `external_identifier` on
  `directus_users`). This schema has no identity/matching logic of its own — it only points `people`
  at the resulting user once one exists.

### Permission model

- **Administrator** — Directus's built-in full-access role.
- **Staff** — authenticates via Directus's native Google OIDC, restricted to Workspace accounts an
  admin has provisioned as Directus users. Full read/write on every collection above, including
  `medical_profiles`, except the collections Clubspot owns (`packages/clubspot/schema.yaml`) are
  read-only — editing happens in Clubspot, not here — apart from `classes.program_id` and
  `participants.person_id`, which Staff set by hand. The only role delivered end-to-end by
  #69/#92-#95.
- **Coach** — defined now so the schema doesn't need reshaping later, but has no way to log in yet
  (needs #65). KISS for now: any authenticated Directus user can read `sessions` /
  `registration_entries` / `people` roster fields (no `medical_profiles`) — scoping a coach to only
  their own sessions via `event_staff` is a follow-up, not built here.
- **Guardian** — same login caveat as Coach. Policy: read their own minors' `people` /
  `medical_profiles` / `registrations` / `registration_entries`, filtered through `contacts` where
  `relationship_type == 'guardian'`. This scoping isn't KISS'd away like the coach roster case above
  — it's the medical-data boundary the permission model exists to get right. Collection-level
  permissions are what's built; whether `medical_profiles` needs field-level restrictions too is a
  question for whenever a Guardian actually logs in (#65), not settled here.
- **Emergency contacts get no role or login.** They're informational rows staff can see on a minor's
  record (`contacts` where `relationship_type == 'emergency_contact'`), not a portal audience.

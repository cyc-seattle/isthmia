---
tags: [architecture, crm, directus]
---

## CRM: schema and permission model

Design doc for the CRM's Directus data model, per the plan agreed on issue #69. Covers person
identity, provenance, and permission policies — see `packages/crm/schema.yaml` for collections and
fields; deployment and rollout are tracked in the sibling issues (#92-#95) that decompose #69.

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

Collections and fields are defined in `packages/crm/schema.yaml`, the source of truth Pulumi
applies to Directus. The sections below cover identity, provenance, and permissions — behavior
that isn't visible in the schema file itself.

`registration_entries` also carries five nullable columns for Clubspot's own per-entry status and
waitlist bookkeeping: `clubspot_status`, `confirmed_at`, `waitlist_number`, `accepted_from_waitlist`,
`priority`. Their field notes in `schema.yaml` cover the why. This file does not repeat it.

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
  — it's the medical-data boundary the permission model exists to get right. Collection-level
  permissions are what's built; whether `medical_profiles` needs field-level restrictions too is a
  question for whenever a Guardian actually logs in (#65), not settled here.
- **Emergency contacts get no role or login.** They're informational rows staff can see on a minor's
  record (`contacts` where `relationship_type == 'emergency_contact'`), not a portal audience.

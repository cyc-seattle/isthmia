---
tags: [architecture, people-hub, directus]
---

## People hub: schema and permission model

Design doc for the Directus data model behind Layer 2 of `docs/architecture.md` (the CRM / people
hub), per the plan agreed on issue #69. Covers the collections, fields, and permission policies;
deployment and rollout are tracked in the sibling issues (#92-#95) that decompose #69.

### Scope and non-goals

- Models what Clubspot actually gives us: people, their guardian/emergency-contact relationships,
  camp sessions, and enrollments. No household grouping — Clubspot has no concept of a household,
  only per-registration guardians and emergency contacts, so that's what the schema keys off.
- Auth identity is deliberately separate from person data — see [Auth identity](#auth-identity)
  below.
- Coach and guardian **portals** (thin clients calling this API) are out of scope; this doc defines
  the roles/policies they'll eventually use, but nothing here provisions their logins. That's #65.

### Collections

**people** — one row per human known to the org: staff, coaches, guardians, participants, emergency
contacts. Not mutually exclusive roles, so a tag field rather than a type enum.

| Field                     | Type                                                                    | Notes                               |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `id`                      | uuid                                                                    | primary key                         |
| `first_name`, `last_name` | string                                                                  |                                     |
| `email`, `phone`          | string, nullable                                                        | contact info, not auth              |
| `date_of_birth`           | date, nullable                                                          | required for minors                 |
| `person_roles`            | tags (`staff`, `coach`, `guardian`, `participant`, `emergency_contact`) | non-exclusive                       |
| `clubspot_id`             | string, nullable, unique                                                | dedup/upsert key for #70's sync     |
| `directus_user_id`        | uuid, nullable, unique, FK -> `directus_users.id`                       | see [Auth identity](#auth-identity) |

**medical_profiles** — one-to-one with `people`, kept as its own collection so its permission policy
can be stricter than a roster-level `people` read (allergies, medications, conditions, physician
contact).

| Field                                    | Type                            | Notes                  |
| ---------------------------------------- | ------------------------------- | ---------------------- |
| `id`                                     | uuid                            | primary key            |
| `person_id`                              | uuid, FK -> `people.id`, unique | one profile per person |
| `allergies`, `medications`, `conditions` | text                            | free-form              |
| `physician_name`, `physician_phone`      | string, nullable                |                        |

**person_relationships** — one join collection for both relationship kinds Clubspot gives us
(guardian and emergency contact), rather than a separate table per type, since the shape is
identical.

| Field               | Type                                   | Notes                                             |
| ------------------- | -------------------------------------- | ------------------------------------------------- |
| `id`                | uuid                                   | primary key                                       |
| `related_person_id` | uuid, FK -> `people.id`                | the minor                                         |
| `person_id`         | uuid, FK -> `people.id`                | the guardian or emergency contact                 |
| `relationship_type` | enum (`guardian`, `emergency_contact`) |                                                   |
| `is_primary`        | boolean                                | contact-order hint when a minor has more than one |

**event_staff** — coach/staff assigned to a session; the row a coach's "see my roster" policy keys
off.

| Field        | Type                      | Notes       |
| ------------ | ------------------------- | ----------- |
| `id`         | uuid                      | primary key |
| `person_id`  | uuid, FK -> `people.id`   |             |
| `session_id` | uuid, FK -> `sessions.id` |             |

**sessions** — camp/program sessions, mirrors Clubspot.

| Field                    | Type                     | Notes             |
| ------------------------ | ------------------------ | ----------------- |
| `id`                     | uuid                     | primary key       |
| `name`, `program`        | string                   |                   |
| `start_date`, `end_date` | date                     |                   |
| `clubspot_session_id`    | string, nullable, unique | dedup key for #70 |

**enrollments** — a participant's registration in a session.

| Field                      | Type                                        | Notes                  |
| -------------------------- | ------------------------------------------- | ---------------------- |
| `id`                       | uuid                                        | primary key            |
| `person_id`                | uuid, FK -> `people.id`                     | the participant        |
| `session_id`               | uuid, FK -> `sessions.id`                   |                        |
| `status`                   | enum (`confirmed`, `waitlist`, `cancelled`) | same vocabulary as #60 |
| `clubspot_registration_id` | string, nullable, unique                    | dedup key for #70      |

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
  (needs #65). Policy: read `sessions` / `enrollments` / `people` filtered through `event_staff` for
  their own sessions. No access to `medical_profiles`.
- **Guardian** — same caveat as Coach. Policy: read their own minors' `people` / `medical_profiles` /
  `enrollments`, filtered through `person_relationships` where `relationship_type == 'guardian'`.
- **Emergency contacts get no role or login.** They're informational rows staff can see on a minor's
  record (`person_relationships` where `relationship_type == 'emergency_contact'`), not a portal
  audience.

### Open questions for the applying slice (#95)

- Exact Directus field types (`uuid` vs. Directus's integer PKs) and whether `person_roles` is a
  Directus "tags" interface field or a normalized M2M — pick whichever keeps the permission filters
  simplest when building the real schema snapshot.
- Whether `medical_profiles` needs field-level (not just collection-level) permissions before a
  Guardian role ever actually logs in.

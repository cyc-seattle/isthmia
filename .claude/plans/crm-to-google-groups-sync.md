# Sync people from the CRM into Google Groups

## Context

Group membership is maintained by hand. `gam/scripts/update-groups-from-contacts:12` hardcodes a
2025 spreadsheet id and six `camp|class|group` mappings that must be edited every season.
`gam/scripts/update-groups-from-roles:30-45` hardcodes the same group list again for volunteer
roles. Groups are both mailing lists and security groups — the portal gate reads one
(`packages/infrastructure/src/infrastructure/substrate-bootstrap.ts:18`) — so stale membership is an
access problem, not only a comms problem. This work is carved out of #71.

Two things block a sync:

1. **`programs` is a Clubspot Camp, not a program.** `schema.yaml:224-248` and
   `packages/crm/src/schedule.ts:10-14` model one row per camp, keyed on `clubspot_camp_id`. "2026
   Fall Double-handed Race Team" and "2026 Spring Double-handed Race Team" are separate rows, so
   nothing durable can carry a group.
2. **The sync's bookkeeping does not generalize.** `sync_runs` / `sync_program_runs`
   (`packages/clubspot-sync/src/sync-log.ts:22-71`) and `campBackoff`
   (`packages/clubspot-sync/src/backoff.ts:39-72`) are one job's run log, not a queue. A failed camp
   is retried on its own cadence with no per-item retry, no visible backlog, and no way for a second
   job to reuse any of it.

## The shape this fits into

This repo is an integration platform. Directus holds the **canonical** model, and each SaaS
product gets a sync package that maps it to one or more app domains:

```text
packages/directus      infrastructure — the REST client and the durable queue
packages/crm           the canonical domain: schema.yaml and its row types. No jobs.
packages/clubspot-sync Clubspot         <-> crm
packages/gsuite-sync   Google Workspace <-> crm     (new, this work)
```

The rule that follows: **a canonical collection describes the org, and anything specific to one
SaaS product is owned by that product's package.** "Fred is a Parent Coordinator of the
Double-handed program" is canonical. "A Parent Coordinator is a manager of that program's Google
Group" is a Google Workspace mapping. The same role later maps to a Directus policy through its
own mapping, without the canonical row changing.

Directus is both the canonical store and a provider in its own right — it has users and roles —
which is why `people.directus_user_id` is a provider-specific column on a canonical table.

### Providers extend canonical collections

Ownership is about **which schema declares a thing**, not about which table it sits on. A provider
may add a field to a canonical collection: `programs.google_group_id` is a real column on
`programs`, declared in `gsuite-sync`'s schema, not in `crm`'s. Staff see it where they expect it,
and the canonical package still knows nothing about Google.

**Every package's schema is merged into one snapshot and applied once.** Not applied per package,
in sequence. Sequential applies cannot work here: `scopeSnapshot`
(`packages/infrastructure/src/directus/client.ts:348`) replaces every live field under a
collection the applying package owns outright, so `crm`'s apply would drop
`programs.google_group_id` — a field it does not declare — and `gsuite-sync`'s later apply would
recreate it empty. That is silent data loss on every deploy. Making the scoping field-granular
does not fix it, because the canonical owner still has no way to know the field is spoken for.

Merging removes the round-trip instead of trying to survive it. The snapshot is complete, so
nothing is missing from it and nothing gets deleted, deleting a field still works, and the
"providers apply after canonical" ordering requirement disappears.

`scopeSnapshot` stays, collection-granular as it was, and keeps its #109 job: a collection **no**
schema declares — something created by hand in the Directus UI — is still preserved rather than
deleted. With a merged snapshot every declared collection is owned, so field-granularity has no
reachable case and is removed.

Consequences, all mild:

- One Pulumi resource owns the whole schema. A package's schema cannot deploy independently of the
  others, which costs nothing on one instance deployed by one `just deploy`.
- `just directus-local` applies the same merged snapshot, so local matches production.
- Permission rules are collection-level, so a provider's field on `programs` is already covered by
  the existing `programs` rules. Nothing to add.
- Row types do not compose automatically: `ProgramRow` in `crm` will not carry `google_group_id`.
  Consumers that need both intersect the two types.

## Approach

Seven new or reshaped collections, one shared queue in a new infrastructure package, and one new
sync package.

### Schema

Applying the rule above, the new collections land in three schemas, each owned by the package that
owns the concern:

| Schema                      | Owns                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `crm` (canonical)           | `programs`, `offerings`, `program_roles`, `program_role_types`                                                 |
| `directus` (infrastructure) | `sync_tasks`, `audit_findings`                                                                                 |
| `gsuite-sync` (provider)    | `google_groups`, `google_group_roles`, and the fields `programs.google_group_id` and `classes.google_group_id` |

`audit_findings` sits with the queue rather than with Google because every sync will want one —
`unlinked_offering` is already a Clubspot finding, not a Google one. The Directus instance is
shared and each package applies its own schema, which is the model
`packages/infrastructure/src/crm/index.ts:9-12` already describes.

**`programs` splits into `programs` + `offerings`.** `offerings` takes `clubspot_camp_id`, `name`,
`start_date`/`end_date`, and a nullable `program_id`. `programs` keeps `name`; its
`google_group_id` is a `gsuite-sync` extension field, not a `crm` one. `sessions`, `classes`,
`registrations`, and `custom_field_definitions` repoint their `program_id` FK to `offering_id`.
Breaking: no manual Directus edits exist and all data re-syncs.

Clubspot has no durable program id, so **staff link an offering to its program by hand**, once per
offering. `planPrograms` (`packages/clubspot-sync/src/schedule.ts:88-94`) becomes `planOfferings` and
never writes `program_id`, so the link survives a re-sync. Staff already touch each new offering to
set its class groups, so this adds no new habit. An offering with no program is an audit finding.

**`google_groups`** (provider) — one row per Google Group: `email`, `name`, `settings_template`,
`parent_id` self-FK. Non-program groups (`all@`, `staff@`) live here too, replacing the GAM "Group
Templates" worksheet (`gam/scripts/apply-templates:8`).

**`programs.google_group_id` and `classes.google_group_id`** (provider extension fields) — FKs on
the canonical collections, declared in `gsuite-sync`'s schema per the section above. The class one
is set per offering. Nullable: a program or class with no group is the normal case.

**`program_roles`** — `person_id`, `program_id`, `role_id`, nullable `starts_on`/`ends_on`.
Separate from `event_staff` (`schema.yaml:140-166`): `event_staff` is person-plus-session and
Clubspot-derived, this is person-plus-program and hand-entered. Mixing sync-owned and hand-entered
rows in one collection is exactly the trap #137 describes.

**`program_role_types`** (canonical) — just `name`. `program_roles.role_id` points here rather
than at a schema enum, so adding a volunteer role is data entry, not a deploy. Seeded with the two
roles `gam/scripts/update-groups-from-roles:38-51` hardcodes today: Parent Coordinator and Group
Manager. It carries no provider behaviour — "Fred is a Parent Coordinator of Double-handed" is the
whole of what it says.

**`google_group_roles`** (provider) — `program_role_type_id`, `google_role` (`MEMBER`, `MANAGER`,
`OWNER`). The mapping that today is hardcoded in `update-groups-from-roles:38-51`. Both seeded
roles map to `MANAGER`. A role with no row here simply has no effect on Google Groups.

Neither is `directus_roles`. A Directus role is an auth role: global rather than per-program,
IaC-managed in `packages/infrastructure/src/infrastructure/directus-roles.ts`, and it decides what
an API caller may read and write. A parent coordinator is a person-program relationship, held
mostly by people with no login at all (`people.directus_user_id` is nullable and usually null).
When these roles do need to grant Directus access, that gets its own mapping collection alongside
`google_group_roles` — the same pattern, a different provider — rather than collapsing the
canonical role into the auth one.

**`audit_findings`** (infrastructure) — `source` (which sync raised it), `kind`, `subject` (what
it is about, a group address here), `detail`, `status` (`open`, `dismissed`). Kinds this work
raises: `unexpected_member`, `settings_drift`, `missing_group`, `unlinked_offering`,
`program_without_group`. Staff dismiss a row and the dismissal persists across runs, so a finding
needs a stable identity the next run can recognise — `source` plus `kind` plus `subject` plus a
hash of `detail`, carried in a unique `fingerprint` column. Without it a dismissed finding returns
on the next pass. No Google Sheet, so the job needs no Sheets dependency. Possible home for a
review UI later (#133).

**`sync_tasks`** — the durable queue: `queue`, `kind`, `key`, `parent_id` self-FK, `status`,
`attempts`, `max_attempts`, `run_after`, `last_error`, `started_at`, `finished_at`. `key` is the
target's natural key, so a re-enqueue updates a pending task instead of piling up. A task may enqueue
children, which makes a run a readable tree in the Directus UI.

### The queue is infrastructure: `packages/directus`

`crm` is an app — its own words, `packages/crm/README.md:3`. A job-orchestrator queue and a
Directus REST client are not that app's concerns; any app on this Directus instance would want
both. They get a new package, `packages/directus`, holding:

- `DirectusClient`, moved from `packages/clubspot-sync/src/directus.ts:58`.
- The queue planner and worker.
- The `sync_tasks` row types.
- `queue-schema.yaml`, this package's own collection, kept out of the CRM app's `schema.yaml`.

The worker is a thin executor over `DirectusClient`; the decisions (which task is claimable, next
`run_after`, when to fail permanently) are pure functions with unit tests, following the
`clubspot-sync` convention.

`sync_tasks` is applied by the **`infrastructure`** Pulumi project, which already owns the Directus
instance, its roles, and its users. The `crm` project keeps applying the CRM app's schema and
nothing else. That is the split `packages/infrastructure/src/crm/index.ts:9-12` already describes,
and it needs no fourth Pulumi project.

> The name collides with `packages/infrastructure/src/directus/`, which holds the Pulumi resource
> classes. Different layer, and arguably those should move here later. Easy to rename now if you
> would rather.

### `clubspot-sync` moves onto the queue

`sync_runs` and `sync_program_runs` become `sync_tasks` rows: one `run` parent, one `offering` child
each. `SyncLog` (`sync-log.ts:57-73`) is deleted.

`backoff.ts` does **not** collapse into `run_after` — verify this before rewriting it. `run_after`
covers retry after failure. `campBackoff` answers a different question: this offering has changed
nothing for N runs, so poll it less often. That is durable per-offering state, and so is the
watermark (`watermarkForCamp`, `sync-log.ts:12-18`), which today is reconstructed from run history
that the queue will prune. Both move to columns on `offerings`: `synced_through` (timestamp) and
`quiet_runs` (integer). The backoff decision stays a pure function; its input becomes one row instead
of the whole run log, which is simpler than today.

### `gsuite` gains a Directory client

`packages/gsuite/src/directory.ts`: `DirectoryClient` (groups, members) and `GroupSettingsClient`,
both taking an `Auth.GoogleAuth` like `CalendarClient` (`packages/gsuite/src/calendar.ts:26`) and
wrapping every call in `safeCall` (`packages/gsuite/src/common.ts:85`). Impersonation is the caller's
problem, not the client's.

### `packages/gsuite-sync` (new)

The Google Workspace side of the platform, mirroring `clubspot-sync` on the Clubspot side. Groups
are what it does today; Workspace users, shared drives, or anything else Google later belong here
too rather than in a second package. Depends on `commodore`, `crm`, `directus`, `gsuite`. Pure plan
functions, thin executor.

`crm` stays a schema-and-types package with no jobs and no `gsuite` dependency, so the transitive
Google dependency on `clubspot-sync` never arises. CLAUDE.md's "no gsuite dependency, by design"
note is dropped anyway in step 10 — the boundary that matters is that a sync package touches one
provider, not that another package avoids a transitive import.

**Membership of a class group**, add-only, never remove:

- Participants with a `registration_entries` row of status `confirmed`
  (`packages/clubspot-sync/src/registrations.ts:38-74`) for a session of that class.
- Their guardians: `contacts.person_id` where `related_person_id` is the participant and
  `relationship_type` is `guardian` (`packages/crm/src/people.ts:18-27`). Never emergency contacts.
- The participant's own email is always included when set, which is what makes an adult with no
  guardian row work without a special case.
- Dedupe by lowercased, trimmed email, so a family sharing one address is added once.

The Directory API accepts an external address as a member. The group must have
`allowExternalMembers: true`, which the participants template already sets
(`gam/templates/participants.json:2`).

**Settings and nesting**: apply the `google_groups.settings_template` JSON through the Groups Settings API,
and make each class group a member of its program group (`google_groups.parent_id`). Class groups are for
discussion, not broadcast — members post to lists they belong to, so a class group takes the
`participants` template (`gam/templates/participants.json`), never `announcement`.

> Nesting does not resolve for cross-domain members. `hasMember` follows nested groups in-domain
> only, and `checkTransitiveMembership` needs Enterprise or Cloud Identity Premium, which CSC does
> not have. A program group must not be used as an oauth2-proxy allowlist (#65, #98) until that is
> solved elsewhere.

**Managers and owners**: a `program_roles` row current on the run date gives its person whatever
`google_group_roles` maps its role type to — `MANAGER` for both seeded roles. Owners come from a
config list of the break-glass super-admins, `master@` today and `commander@` once #81 lands.

**Audit**: one pass per run compares live membership and settings against the plan and writes
`audit_findings` rows for the differences. It never removes anyone.

### Auth and infrastructure

The job runs as a new `gsuite-sync-runner` service account
(`packages/infrastructure/src/bootstrap/gsuite-sync.ts`, mirroring `bootstrap/clubspot-sync.ts:6`).
Writing groups needs `https://www.googleapis.com/auth/admin.directory.group` and
`https://www.googleapis.com/auth/apps.groups.settings` — both wider than the read-only scope the
substrate holds today (`docs/manual-setup.md:99-101`), so this is a separate identity, not a reuse of
`substrate-runner`.

**Assign the Groups Administrator role directly to the service account. Do not use domain-wide
delegation.** Google supports assigning any prebuilt role except Super Admin to a service account,
and names the Admin SDK Groups API as working this way with no delegation and no impersonation.
That is better than delegation on three counts: no Admin-console delegation step, privilege scoped
to groups instead of "acts as a super-admin", and audit-log entries attributed to the job rather
than to `master@`. The assignment itself is a manual Admin-console step, recorded in
`docs/manual-setup.md` §5.

**The Groups Settings API is the open risk.** Google's announcement covers the Directory API and
the Cloud Identity Groups API; it does not mention Groups Settings, and no doc says either way.
Membership therefore works under the role assignment, and settings may not. Prove it with one
throwaway group before building step 7. If settings reject the credential, do not add delegation
for them — drop the settings and settings-drift passes from v1 and leave
`gam/scripts/apply-templates` as the way settings are applied, which step 10 keeps anyway. The
drift check reads through the same API, so it falls with the write.

The credential is ADC, no key file. No `tokenCreator` self-grant is needed, unlike
`packages/infrastructure/src/infrastructure/substrate.ts:33-37`, because nothing is impersonated.
The job stays compatible with #83: the scopes are `main.ts` arguments.

Directus access is a second static token with its own machine user, following
`clubspot-sync-directus-token` (`packages/infrastructure/src/infrastructure/directus.ts:62`). Its
policy is read on `people`, `contacts`, `registrations`, `registration_entries`, `classes`,
`offerings`, `programs`, `google_groups`, `google_group_roles`, `program_roles`,
`program_role_types`, and write on `sync_tasks` and `audit_findings`
only. No GCP project roles. Nothing changes in `config.ts` — this identity is not a deployer.

### What can be tested

Every plan function is pure and unit tested. The Directory and Groups Settings clients are tested
against a mocked `googleapis` boundary, as `packages/gsuite/test/calendar.test.ts` does. Two things
can only be checked live: that the role assignment works, and that Google accepts a settings
template as written. Check both with a `--dry-run` run against one throwaway group before the first
real run, and keep `gam/scripts/export-groups` and `export-group-members` as the read-back.

## Alternatives

- **Directus Flows for the workflow.** An event router, not a workflow engine: no persisted execution
  state, no resume after a restart, no retry, and Run Script is isolated-vm with no network, so it
  cannot reach Google at all.
- **Cloud Tasks, GCP Workflows, or Temporal.** Temporal's datastore costs more than the substrate VM
  beside it. Workflows' YAML steps are not unit testable, which fights the plan-function convention.
  Neither is needed at this scale, and the driver is failure visibility, not latency.
- **A durable class entity above the offering.** Four levels before a person, still needs a
  per-offering mapping step, and no home for `all@`.
- **A `google_group_email` string on the class row.** No home for settings or nesting.
- **Naming the new level `season`, `term`, or `edition`.** `season` is one letter from `sessions`.
  `term` reads as a shared calendar period. `edition` reads wrong for a recurring class.
- **Putting the queue and `DirectusClient` in `packages/crm`.** Both are infrastructure any app on
  this Directus instance would want; `crm` is one app on it.
- **`program_roles.role` as a `directus_roles` FK.** Directus roles are global auth roles; this is a
  per-program relationship held mostly by people with no login. It would remove no column and would
  blur the authentication/authorization split.
- **`program_roles.role` as a schema enum.** Adding a volunteer role would be a deploy rather than
  data entry.
- **`grants_group_manager` on `program_role_types`.** Google behaviour on a canonical row. It moved
  to `google_group_roles`.
- **Reversing the FK, so `google_groups` carries `program_id`/`class_id`.** Avoids a provider
  column on a canonical table, but at the cost of reading backwards everywhere, and it does not
  generalize: the existing `clubspot_*` id columns cannot reverse without a join in every sync's
  hot path. Provider-owned extension fields get the same isolation with none of that.
- **The job inside `packages/crm`.** Makes the canonical domain package depend on one provider's
  SDK. `gsuite-sync` keeps each provider's mapping in its own package.

## Decided

Settled with the user before implementation started.

- **An offering is linked to its program by hand**, once per offering, roughly a dozen times a year.
  Rejected a `program_matchers` pattern table: more code, and it silently mislinks a renamed camp.
- **A program gets a group only if its `google_group_id` is set.** There is no other rule;
  `program_without_group`
  makes the omission visible instead of silent.
- **Groups are for discussion.** Members post to lists they belong to. Listmonk still gets its own
  list sync later for the newsletter (#71), reading the same CRM.
- **Group owners are config constants**, not CRM data — `master@` today, `commander@` once #81 lands.
  Ownership is a break-glass boundary and should not be editable from the admin UI.
- **The rule applies to every provider, including the ones already here.** Extension fields make
  that affordable, so `offerings.clubspot_camp_id`, `sessions.clubspot_session_id`,
  `registrations.clubspot_registration_id` and the rest move to `clubspot-sync`'s schema, and
  `people.directus_user_id` to `directus`'s. No column moves table and no data migrates — only the
  file that declares it changes. Step 11 does it last, once everything else works, so it cannot
  destabilize the earlier steps.

## Open questions

1. **Does the Groups Settings API accept a service-account role assignment?** Unknown, and the only
   thing gating the settings and settings-drift passes. Test before step 8; fall back to leaving
   settings with `gam/scripts/apply-templates`.
2. **Sync notifications (#122).** Deferred. The queue makes failures visible in Directus, which
   weakens the case for a Chat message. When it is answered, the queue shapes the answer: one
   "N tasks failed permanently" message per run, not per-item alerting. One answer for both syncs.

## Steps

1. **Split `programs` into `programs` + `offerings`.** `schema.yaml`, `packages/crm/src/schedule.ts`,
   and the `clubspot-sync` rename (`schedule.ts`, `registrations.ts`, `sync-run.ts`, tests) in one
   commit — the build breaks if they are separated.
2. **Add the canonical `program_role_types` and `program_roles` collections** to `crm` and their
   row types. Nothing reads them yet.
3. **Merge every package's schema into one snapshot and apply it once.** This supersedes the
   field-granular `scopeSnapshot` in `2fd568a1`, which was the first attempt and cannot work — a
   canonical owner's apply still drops an extension field it does not declare, losing that
   column's data on every deploy. Revert `scopeSnapshot` to collection-granular, keeping its #109
   job of preserving collections no schema declares. Merge in both the Pulumi `crm` project and
   `scripts/directus-local` so local matches production. Nothing declares an extension field yet —
   this is the enabling step, and proving it alone keeps step 7 from debugging two new things at
   once.
4. **Create `packages/directus`:** move `DirectusClient` into it, add `sync_tasks` and
   `audit_findings` in its own schema, the queue planner, the worker, and unit tests. Apply the
   schema from the `infrastructure` Pulumi project.
5. **Move `clubspot-sync` onto the queue.** Delete `sync-log.ts`, drop `sync_runs` /
   `sync_program_runs`, add `offerings.synced_through` and `offerings.quiet_runs`, and rewrite
   `backoff.ts` against the offering row.
6. **Add `DirectoryClient` and `GroupSettingsClient` to `gsuite`,** with mocked-SDK tests.
7. **Create `packages/gsuite-sync`** with its `google_groups` / `google_group_roles` schema and the
   membership pass: class-group plan functions, the add-only executor, and the CLI. Seeds from each
   program's current offering forward.
8. **Add the settings, nesting, manager, and owner passes.**
9. **Add the audit pass** writing `audit_findings`.
10. **Deploy it:** the `gsuite-sync` Dockerfile target, the bootstrap identity, the Directus machine
    user and token, the Cloud Run job and scheduler, and the `docs/manual-setup.md` step for the
    Groups Administrator role assignment.
11. **Move the existing provider id columns to their owners' schemas.** `clubspot_camp_id`,
    `clubspot_session_id`, `clubspot_class_id`, `clubspot_registration_id`,
    `clubspot_participant_id`, `clubspot_entry_cap_id`, `clubspot_custom_field_id`,
    `clubspot_session_join_id` and `clubspot_billing_id` are declared by `clubspot-sync`;
    `people.directus_user_id` by `directus`. No column moves table and no data migrates — only the
    declaring file changes, plus the row types that then need composing. Last, so a pure
    reorganization cannot destabilize anything above it.
12. **Retire the replaced GAM scripts.** Delete `update-groups-from-contacts` and
    `update-groups-from-roles`. Keep `export-groups`, `export-group-members`, `apply-templates`, the
    justfile, and the README as the break-glass path. Update the `gam` README and
    `docs/crm-schema.md`. In CLAUDE.md: add the two new packages, redraw the dependency graph, drop
    the "no gsuite dependency, by design" note on `clubspot-sync`, and record the
    canonical-vs-provider rule and the extension-field mechanism from the top of this doc — both
    outlive this work.

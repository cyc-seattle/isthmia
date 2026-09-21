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

## Approach

Six new or reshaped collections, one shared queue in a new infrastructure package, and one new
Cloud Run job inside the CRM app.

### Schema (`packages/crm/schema.yaml`, `packages/crm/src/`)

**`programs` splits into `programs` + `offerings`.** `offerings` takes `clubspot_camp_id`, `name`,
`start_date`/`end_date`, and a nullable `program_id`. `programs` keeps `name` and gains
`google_group_id`. `sessions`, `classes`, `registrations`, and `custom_field_definitions` repoint
their `program_id` FK to `offering_id`. Breaking: no manual Directus edits exist and all data
re-syncs.

Clubspot has no durable program id, so **staff link an offering to its program by hand**, once per
offering. `planPrograms` (`packages/clubspot-sync/src/schedule.ts:88-94`) becomes `planOfferings` and
never writes `program_id`, so the link survives a re-sync. Staff already touch each new offering to
set its class groups, so this adds no new habit. An offering with no program is an audit finding.

**`google_groups`** — one row per Google Group: `email`, `name`, `settings_template`, `parent_id`
self-FK. `programs.google_group_id` points at the program group. `classes.google_group_id` points
at the class group and is set per offering. Non-program groups (`all@`, `staff@`) live here too,
replacing the GAM "Group Templates" worksheet (`gam/scripts/apply-templates:8`).

**`program_roles`** — `person_id`, `program_id`, `role_id`, nullable `starts_on`/`ends_on`.
Separate from `event_staff` (`schema.yaml:140-166`): `event_staff` is person-plus-session and
Clubspot-derived, this is person-plus-program and hand-entered. Mixing sync-owned and hand-entered
rows in one collection is exactly the trap #137 describes.

**`program_role_types`** — `name`, `grants_group_manager` boolean. `program_roles.role_id` points
here rather than at a schema enum, so adding a volunteer role is data entry, not a deploy. Seeded
with the two roles `gam/scripts/update-groups-from-roles:38-51` hardcodes today, Parent Coordinator
and Group Manager, both granting manager.

These are **not** `directus_roles`. A Directus role is an auth role: it decides what an API caller
may read and write, it is global rather than per-program, and it is IaC-managed in
`packages/infrastructure/src/infrastructure/directus-roles.ts`. A parent coordinator is a
relationship between a person and a program, held mostly by people with no Directus login at all
(`people.directus_user_id` is nullable and usually null). Pointing at `directus_roles` would not
even remove a column — `program_id` still has to live on the join row — while it would add auth
roles that grant nothing and blur the authentication/authorization split `docs/architecture.md`
keeps deliberate. If a volunteer later needs to sign in, they get a Directus role _as well_, which
is the correct relationship between the two.

**`audit_findings`** — `kind` (`unexpected_member`, `settings_drift`, `missing_group`,
`unlinked_offering`, `program_without_group`), `group_email`, `detail`, `status` (`open`,
`dismissed`). Staff dismiss a row and the dismissal persists across runs, so a finding needs a
stable identity the next run can recognise — `kind` plus `group_email` plus a hash of `detail`,
carried in a unique `fingerprint` column. Without it a dismissed finding returns on the next pass.
No Google Sheet, so the job needs no Sheets dependency. Possible home for a review UI later
(#133).

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

### The job lives in `packages/crm`

Pushing the CRM's people into that app's groups is app logic, so it goes in the app: a new
`src/groups/` and a second CLI entry point in `packages/crm`, not a package of its own. `crm` gains
`commodore`, `gsuite`, and `directus` as dependencies, a `bin`, and a Dockerfile target. It stops
being a types-and-schema package and becomes the CRM app proper. Pure plan functions, thin
executor, on the `clubspot-sync` pattern.

> **This breaks a stated rule and needs your call.** `clubspot-sync` depends on `crm`, so the
> moment `crm` depends on `gsuite`, `clubspot-sync` gets Google transitively — and CLAUDE.md's
> dependency graph says `clubspot-sync` has "no gsuite dependency, by design". Three ways out:
>
> 1. **Accept it** and reword the rule as a code-level one: the Clubspot sync calls no Google API,
>    even though its image now carries `googleapis`.
> 2. **Fold `clubspot-sync` into `crm` too**, so the CRM app owns both of its jobs and the package
>    boundary stops carrying the rule. Consistent, and the natural end state of this comment, but
>    much larger than this batch.
> 3. **Keep the job in its own `packages/groups-sync`**, the original design. Preserves the rule at
>    the cost of the app/infrastructure symmetry you just asked for.
>
> The doc assumes (1). Say if you want (2) or (3).

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

**Managers and owners**: managers come from `program_roles` rows that are current on the run date.
Owners come from a config list of the break-glass super-admins — `master@` today, `commander@` once
#81 lands.

**Audit**: one pass per run compares live membership and settings against the plan and writes
`audit_findings` rows for the differences. It never removes anyone.

### Auth and infrastructure

The job runs as a new `groups-sync-runner` service account
(`packages/infrastructure/src/bootstrap/groups-sync.ts`, mirroring `bootstrap/clubspot-sync.ts:6`).
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
`offerings`, `programs`, `google_groups`, `program_roles`, and write on `sync_tasks` and `audit_findings`
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

## Decided

Settled with the user before implementation started.

- **An offering is linked to its program by hand**, once per offering, roughly a dozen times a year.
  Rejected a `program_matchers` pattern table: more code, and it silently mislinks a renamed camp.
- **A program gets a group only if `google_group_id` is set.** There is no other rule. `program_without_group`
  makes the omission visible instead of silent.
- **Groups are for discussion.** Members post to lists they belong to. Listmonk still gets its own
  list sync later for the newsletter (#71), reading the same CRM.
- **Group owners are config constants**, not CRM data — `master@` today, `commander@` once #81 lands.
  Ownership is a break-glass boundary and should not be editable from the admin UI.

## Open questions

1. **Does the Groups Settings API accept a service-account role assignment?** Unknown, and the only
   thing gating the settings and settings-drift passes. Test before step 7; fall back to leaving
   settings with `gam/scripts/apply-templates`.
2. **Sync notifications (#122).** Deferred. The queue makes failures visible in Directus, which
   weakens the case for a Chat message. When it is answered, the queue shapes the answer: one
   "N tasks failed permanently" message per run, not per-item alerting. One answer for both syncs.

## Steps

1. **Split `programs` into `programs` + `offerings`.** `schema.yaml`, `packages/crm/src/schedule.ts`,
   and the `clubspot-sync` rename (`schedule.ts`, `registrations.ts`, `sync-run.ts`, tests) in one
   commit — the build breaks if they are separated.
2. **Add the `google_groups`, `program_role_types`, `program_roles`, and `audit_findings`
   collections** and their row types. Nothing reads them yet.
3. **Create `packages/directus`:** move `DirectusClient` into it, add `sync_tasks` and its
   `queue-schema.yaml`, the queue planner, the worker, and unit tests. Apply the schema from the
   `infrastructure` Pulumi project.
4. **Move `clubspot-sync` onto the queue.** Delete `sync-log.ts`, drop `sync_runs` /
   `sync_program_runs`, add `offerings.synced_through` and `offerings.quiet_runs`, and rewrite
   `backoff.ts` against the offering row.
5. **Add `DirectoryClient` and `GroupSettingsClient` to `gsuite`,** with mocked-SDK tests.
6. **Add `packages/crm/src/groups/` with the membership pass:** class-group plan functions, the
   add-only executor, and a second CLI entry point. Seeds from each program's current offering
   forward. This is the step that gives `crm` its `gsuite` dependency.
7. **Add the settings, nesting, manager, and owner passes.**
8. **Add the audit pass** writing `audit_findings`.
9. **Deploy it:** the Dockerfile target for the new entry point, the bootstrap identity, the
   Directus machine user and token, the Cloud Run job and scheduler, and the `docs/manual-setup.md`
   step for the Groups Administrator role assignment.
10. **Retire the replaced GAM scripts.** Delete `update-groups-from-contacts` and
    `update-groups-from-roles`. Keep `export-groups`, `export-group-members`, `apply-templates`, the
    justfile, and the README as the break-glass path. Update the `gam` README, `docs/crm-schema.md`,
    and CLAUDE.md's package list and dependency graph.

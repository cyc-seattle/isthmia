# @cyc-seattle/gsuite-sync

A Cloud Run job that syncs class and program group membership, managers, owners, and settings from
the CRM's Directus instance (`@cyc-seattle/crm`) into Google Groups. Mirrors `clubspot-sync` on the
Google Workspace side.

## Running locally

Start a local Directus and Postgres with `just directus-local` from the repository root. It applies
the merged schema, including this package's `google_groups` and `google_group_roles` collections,
to a fresh instance.

Then run the CLI against it:

```sh
DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=... \
pnpm exec gsuite-sync --dry-run
```

Google API calls authenticate with Application Default Credentials — run `just auth-adc` first.

Options:

- `--directus-url <url>` - the base URL of the CRM's Directus instance (env `DIRECTUS_URL`)
- `--directus-token <token>` - a Directus static token for the sync's machine user (env
  `DIRECTUS_TOKEN`)
- `--group-owners <emails>` - comma-separated break-glass super-admin emails granted `OWNER` on
  every group (env `GSUITE_SYNC_GROUP_OWNERS`). Required, with no default: ownership is a security
  boundary, so the deployed value lives in the infrastructure that grants it
  (`infrastructure/src/infrastructure/gsuite-sync-job.ts`, overridable with the `groupOwners`
  Pulumi config key) rather than in this package's source.
- `--dry-run` - log the writes the sync would make, without making them. The audit pass still reads
  live Google state, since reads have no side effects.

Prefer the env vars over `--directus-token`. A flag value is visible to anyone on the box who runs
`ps` (#49).

## Shape of the code

Each pass is a pure plan function, and a thin executor writes the plan, following the
`clubspot-sync` convention:

- `membership.ts` - plans a class group's members.
- `nesting.ts` - plans which groups nest under a program group.
- `roles.ts` - plans manager assignments from `program_roles` and `google_group_roles`.
- `owners.ts` - plans owner assignments from the configured owner list.
- `settings.ts` - plans which groups have a settings template to apply.
- `audit.ts` / `audit-settings.ts` - plan the findings an audit run should raise.
- `directory-writer.ts` / `settings-writer.ts` - the `MemberAdder` and `SettingsApplier` executors,
  and their dry-run variants.
- `audit-writer.ts` - reads live Google state and reconciles it against `audit_findings`.
- `run.ts` - enqueues one task per due unit of work onto `@cyc-seattle/directus`'s queue, then
  drains it. `main.ts` is the CLI.

## Behaviours worth knowing before you change this

**Every write pass is add-only.** A person removed from `registration_entries`, or a role revoked
in `program_roles`, simply stops being re-added on the next run — nobody is ever removed from a
Google Group by this job.

**The audit pass reports, it never prunes.** It compares live membership and settings against the
plan and writes `audit_findings` rows for the differences, including members the sync didn't add.
Resolving a finding is a human decision, not something a later run does automatically.

**A dismissed finding never re-raises for the same fingerprint.** A finding's identity is
`source` + `kind` + `subject` + a hash of its detail. Once staff dismiss a row, the same condition
recurring never reopens it, so staff never have to re-triage a finding they already resolved. Only
a change to the underlying detail produces a new fingerprint and a fresh row.

**Group owners come from config, not the CRM.** `--group-owners` (or its default) is the whole
input to the owners pass. Ownership is a break-glass boundary and is deliberately not editable from
the Directus admin UI.

**A program group must not be used as an oauth2-proxy allowlist.** Nested group membership resolves
in-domain only — `hasMember` doesn't follow a cross-domain member through a nested group on
Workspace Business Standard, and the tier that would fix it (`checkTransitiveMembership`) needs
Enterprise or Cloud Identity Premium. See #65 and #98.

**A re-enqueue never resets a struggling task's failure count.** Every run re-enqueues every due
unit of work, but `@cyc-seattle/directus`'s queue carries a task's `attempts` and `last_error`
forward as long as it isn't `done` or `cancelled`, so a task failing every night stays visibly at
that count instead of resetting to zero each run. Once `attempts` reaches `max_attempts`, the queue
sets `needs_attention` on the row but keeps retrying it on its normal backoff schedule — a stuck
task must self-heal once the underlying Google outage clears, not sit parked until a human notices
and re-enqueues it by hand.

## Open questions

- **Does the Groups Settings API accept this job's service-account role assignment?** Unresolved.
  If it doesn't, `gam/scripts/apply-templates` stays the way settings are applied, and the settings
  and settings-drift passes should be dropped rather than worked around with delegation.
- **Sync notifications.** Deferred (#122). `sync_tasks.needs_attention` makes a chronically failing
  task visible in the Directus admin UI today.

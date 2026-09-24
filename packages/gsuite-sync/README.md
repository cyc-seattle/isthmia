# @cyc-seattle/gsuite-sync

A Cloud Run job that syncs program group membership, owners, and settings from the CRM's Directus
instance (`@cyc-seattle/crm`) into Google Groups, and syncs `google_groups` itself the other way: a
discovery pass lists every group and its nesting from Workspace so staff never hand-type a group's
address. Mirrors `clubspot-sync` on the Google Workspace side.

Google is the source of truth for which groups exist and how they nest. The CRM stays the source
of truth for who should be in them, and for which group a program points at. Groups hang off
programs only - a class has no group of its own.

## Running locally

Start a local Directus and Postgres with `just directus-local` from the repository root. It applies
the merged schema, including this package's `google_groups` collection, to a fresh instance. Run
the CLI once and the discovery pass populates `google_groups` from Workspace; nothing needs to be
entered there by hand. What staff still set by hand is the link from a program to its group
(`programs.google_group_id`) - discovery can't infer that.

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
- `--customer <id>` - the Workspace customer id the discovery pass lists groups for (env
  `GSUITE_SYNC_CUSTOMER`). Required, with no default: the service account holds a direct Groups
  Administrator role rather than impersonating a domain user, so the `my_customer` alias 404s for
  it and a real customer id must be supplied.
- `--dry-run` - log the writes the sync would make, without making them. The audit pass still reads
  live Google state, since reads have no side effects.

Prefer the env vars over `--directus-token`. A flag value is visible to anyone on the box who runs
`ps` (#49).

## Shape of the code

Each pass is a pure plan function, and a thin executor writes the plan, following the
`clubspot-sync` convention:

- `discovery.ts` - plans `google_groups` upserts and nesting from live Workspace state.
- `camps.ts` - the ~12-month membership window a class's camp must fall in to contribute
  participants (see `isCampInMembershipWindow`).
- `membership.ts` - plans a program group's members: participants and guardians reached through its
  classes within the membership window, and anyone holding a current `program_role_assignments`
  row (never windowed).
- `nesting.ts` - plans which groups nest under a program group.
- `owners.ts` - plans owner assignments from the configured owner list.
- `settings.ts` - plans which groups have a settings template to apply.
- `audit.ts` / `audit-settings.ts` - plan the findings an audit run should raise.
- `directory-writer.ts` / `settings-writer.ts` - the `MemberAdder` and `SettingsApplier` executors,
  and their dry-run variants.
- `discovery-writer.ts` - lists Workspace groups and membership, and writes the discovery plan.
- `audit-writer.ts` - reads live Google state and reconciles it against `audit_findings`.
- `run.ts` - enqueues one task per due unit of work onto `@cyc-seattle/directus`'s queue, then
  drains it. `main.ts` is the CLI.

## Behaviours worth knowing before you change this

**Discovery runs before every other pass, on its own queue.** Membership, settings, nesting, and
owners all read `google_groups`, so discovery has to finish writing it first. It uses a separate
`sync_tasks` queue value from the rest (`gsuite-sync-discovery` vs `gsuite-sync`) so that ordering
is guaranteed rather than left to the shared queue's claim order.

**Discovery only ever adds a `parent_id`, never clears one.** It sets a group's `parent_id` when
live Workspace membership shows it nested under another group, but leaves an existing `parent_id`
alone when it finds no live nesting - that value may be hand-set, waiting for the nesting pass to
apply it to Workspace. Once applied, the next discovery run derives the same `parent_id` from live
state, which is what makes today's hand-set `parent_id` redundant going forward.

**Discovery never touches `settings_template`, or a program's `google_group_id`.** Those are
staff-set and can't be inferred from Workspace - discovery only creates a row and refreshes its
`name`. `settings_template` is a template _name_ staff pick from a Directus dropdown (`announcement`,
`crew`, `inbox`, or `participants`), not a settings payload - the settings pass resolves it against
`@cyc-seattle/gsuite`'s `resolveGroupSettingsTemplate`, which throws on an unrecognized name rather
than leaving the group unmanaged.

**A `google_groups` row survives its group's disappearance from Workspace.** Discovery neither
deletes nor flags it; deleting would silently break whatever program points at it. The audit pass's
`missing_group` finding already reports the row as stale the next time it runs.

**Every write pass is add-only.** A person removed from `registration_entries`, or a role revoked
in `program_role_assignments`, simply stops being re-added on the next run — nobody is ever removed
from a Google Group by this job.

**A program's membership task is enqueued on `google_group_id` alone, not on having a due class.**
A program whose only current activity is a `program_role_assignments` row — off-season, or set up
before its first class exists — still needs its role holders synced (#149). The membership window
below decides which _participants_ get added once the task runs; it plays no part in whether the
task runs at all.

**A class only contributes participants within a ~12-month trailing window of its camp's
`end_date`** (`isCampInMembershipWindow`), so a just-finished season's roster stays in the group
until the next one begins rather than the group emptying out between seasons. Program role
assignments aren't subject to this window — they have their own `starts_on`/`ends_on`.

**The audit pass reports, it never prunes.** It compares live membership and settings against the
plan and writes `audit_findings` rows for the differences, including members the sync didn't add.
Resolving a finding is a human decision, not something a later run does automatically.

**A member who aged out of the membership window is `stale_member`, not `unexpected_member`.** The
audit computes both a windowed and an unwindowed plan; a live member absent from the first but
present in the second still has a real registration or role, just an old one, so it's flagged
distinctly from someone who was never planned at all.

**`mismatched_revenue_account` flags a Clubspot Camp with more than one revenue account.** A camp
has a single sales account (`camps.clubspot_sales_account`), so every class in it should map to
programs sharing one `programs.revenue_account`. A program with no `revenue_account` set isn't a
conflict by itself — only two or more distinct non-null values are. Tagged `clubspot-sync`, like
`class_without_program`: a finance/Clubspot concern this pass happens to compute.

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

- **Sync notifications.** Deferred (#122). `sync_tasks.needs_attention` makes a chronically failing
  task visible in the Directus admin UI today.

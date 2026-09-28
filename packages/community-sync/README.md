# @cyc-seattle/community-sync

A Cloud Run job that prepares and grants the login Authentik needs for the community roster
(#166). It's the one write path from the CRM's Directus instance into Authentik; every read a
family or staff member makes afterward goes through Directus's own permission rules, not this job.

Three passes, each a pure plan function plus a thin executor, following the `gsuite-sync`
convention:

- **Login email.** Writes `people.login_email` for every person - `normalizeEmail(people.email)`,
  or null when `isValidEmail` fails. This is the one login-to-person mapping the sync keeps, kept
  only for case: a shared address needs no mapping, since Directus's `_eq` matches every row that
  carries it.
- **Staff group.** Mirrors the `all@` Google Group, including nested members
  (`listMembers(..., { includeDerivedMembership: true })`), into the Authentik group `staff`.
- **Family group.** Adds every distinct `login_email` of a current participant - a confirmed
  `registration_entries` row in a class whose camp is active right now - or their guardian, into
  the Authentik group `families`. Off by default; pass `--families` once the board approves sharing
  names and contact information (see the design's "Launch prerequisite").

Both group passes create any missing Authentik user first, keyed on the lowercased email as its
username, with no password - login happens through Authentik's Google source or the email-code
flow, never a password. They then reconcile the group's full membership in one call, so a stale
member is removed, not just left un-re-added the way `gsuite-sync`'s Google Groups passes are
add-only.

## Running locally

```sh
DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=... \
AUTHENTIK_URL=https://login.cycsail.team AUTHENTIK_TOKEN=... \
pnpm exec community-sync --dry-run
```

Google API calls authenticate with Application Default Credentials — run `just auth-adc` first.

Options:

- `--directus-url <url>` - the base URL of the CRM's Directus instance (env `DIRECTUS_URL`)
- `--directus-token <token>` - a Directus static token for the sync's machine user (env
  `DIRECTUS_TOKEN`)
- `--authentik-url <url>` - the base URL of the Authentik instance (env `AUTHENTIK_URL`)
- `--authentik-token <token>` - an Authentik API token for the sync's service account (env
  `AUTHENTIK_TOKEN`)
- `--staff-source-group <email>` - the Google Group the staff pass mirrors (env
  `COMMUNITY_SYNC_STAFF_GROUP`), default `all@cyccommunitysailing.org`
- `--families` - enable the family pass (env `COMMUNITY_SYNC_FAMILIES`, enabled by the variable
  merely being set, regardless of its value)
- `--allow-large-removal` - allow a group reconcile that would empty the group or remove more than
  half its current members, refused by default (see `group-diff.ts`)
- `--dry-run` - log the writes the sync would make, without making them. Directus and Google reads
  still execute live, since reads have no side effects.

Prefer the env vars over `--directus-token`/`--authentik-token`. A flag value is visible to anyone
on the box who runs `ps` (#49).

## Deployment

Runs as the `community-sync-job` Cloud Run job, triggered hourly by Cloud Scheduler
(`infrastructure/src/infrastructure/community-sync-job.ts`). The service account holds a read-only
custom Admin role (Groups → Read) assigned by hand, not domain-wide delegation - see
`docs/manual-setup.md` §5.5. `--staff-source-group` and `--families` are overridable there with the
`communitySyncStaffGroup` and `communitySyncFamilies` Pulumi config keys; `--families` stays off
until the board approves sharing names and contact information.

## Shape of the code

- `schema.ts` - `PersonWithLoginEmail`, the `login_email` provider extension type.
- `login-email.ts` / `login-email-executor.ts` - the login-email plan and its executor.
- `camps.ts` - `isCampActive`, the exact Directus "Active camp" rule the family pass filters on.
- `family-group.ts` - plans the family group's target emails.
- `staff-group.ts` - plans the staff group's target emails from a `listMembers` result.
- `group-diff.ts` - the pure add/remove diff between a group's current and target members, shared
  by both group passes.
- `authentik.ts` - `AuthentikClient`, the interface a test mocks, and `HttpAuthentikClient`, its
  real implementation against Authentik's REST API.
- `group-executor.ts` - `reconcileGroupMembership`, the thin executor: ensures a user exists for
  every target email, then replaces the group's membership in one call.
- `run.ts` - runs the three passes in order and records one `sync_runs` row. `main.ts` is the CLI.

## Behaviours worth knowing before you change this

**Both group passes remove, unlike `gsuite-sync`'s Google Groups passes.** A stale member of
`staff` or `families` keeps portal access, so `reconcileGroupMembership` always writes the group's
full target membership, not just the emails it needs to add.

**The family pass never re-derives a person's email from `people.email` directly.** It reads only
`login_email`, so a person with an unusable `people.email` is skipped and counted, the same as one
with no resolvable person - never silently defaulted to some other address.

**`planGroupDiff` refuses a plan that would empty a group with current members, or remove more
than half of them** - an empty or collapsed Google Groups or Directus read otherwise looks
indistinguishable from "remove everyone," and `reconcileGroupMembership` writes the group's full
target membership in one call. Pass `--allow-large-removal` for a deliberate one.

**`isCampActive` has no grace period.** Unlike `gsuite-sync`'s ~12-month membership window, a
family's roster access tracks the design's "Active camp" Directus rule exactly
(`start_date <= now <= end_date`), so the group a job run computes matches what the live permission
rule will grant. A camp missing either date doesn't count as active, matching how a null date of
birth fails Directus's `_lte` for the Adult rule.

## Open questions

- The family pass stays off in production until the board approves sharing names and contact
  information.

# Handling Clubspot data the CRM schema rejects

## Context

`clubspot-sync` has never completed a camp in production. Every run since it was turned on reports
`programsChecked: 38, programsSynced: 0`; the 38 camps fail in three classes that partition the set
exactly (11 + 13 + 14).

The camps are not untouched. `applyPlan` (`packages/clubspot-sync/src/sync-run.ts:171`) writes each
collection to Directus as it is planned, and nothing wraps a camp in a transaction, so a camp that
throws has already committed everything upstream of the throw. `programsSynced` counts only camps
that finished every collection. So the CRM already holds programs for all 38, schedule rows for the
27 that got past `planSessions`, and people, registrations and registration entries for the 14 that
reached billing. The real failure mode is **one bad row leaves a camp half-written, and every run
re-walks the same path and dies in the same place** — hourly, since `campBackoff` deliberately does
not lengthen the interval after a failure (`packages/clubspot-sync/src/backoff.ts:32-36`).

**Class A — dateless session (11 camps, #131).** `toDateString`
(`packages/clubspot-sync/src/schedule.ts:31`) dereferences `session.get("startDate")`, which is
`undefined` on live data. `CampSessionAttributes` declares both dates required
(`packages/clubspot-sdk/src/types.ts:301-302`); `sessions.start_date` / `end_date` are
`is_nullable: false` (`packages/crm/schema.yaml:4145`, `:4185`). Clubspot's UI requires both dates
today, so these are legacy 2024 records: a closed set, not a recurring shape.

**Class B — entry cap on an unresolvable session (13 camps, not filed).** `requireLookup`
(`schedule.ts:21-27`) throws from `planEntryCaps` (`schedule.ts:142`). Each affected camp names
exactly one session id and all 13 are distinct — one bad cap per camp, with any others hidden behind
the throw.

Sessions are fetched with `.notEqualTo("archived", true)` (`packages/clubspot-sync/src/main.ts:62`)
while entry caps come off `campClass.get("entryCapsArray")` unfiltered (`main.ts:66`). The lookup
map is built from the whole CRM `sessions` table, not just this camp's fetch (`sync-run.ts:269`), so
an unresolvable id means that session has **never** been in the CRM. Archived before the sync ever
ran, and deleted in Clubspot leaving a cap pointing at nothing, both produce exactly that. Telling
them apart needs a live Clubspot query, which this session had no credentials for.

**Class C — missing billing currency (14 camps).** Not a bad-data problem at all:
`queryCampEntries` did not `include("billing_registration")`, so the billing pointer was never
fetched and every `get` on it returned `undefined` — amounts silently zeroed by `centsOrZero`, and
`currency` rejected by Directus. Fixed in `2a416f10`; `registration_billing` was empty, so there
were no zeroed rows to clean up. What remains is the residual case below.

## Approach

**Policy.** A missing scalar makes the column nullable. An unresolvable reference skips the row,
with a warning naming both ids. Never fabricate a value, and never drop a row silently.

**Class A — nullable dates, as hardening.** `sessions.start_date` / `end_date` become nullable in
`packages/crm/schema.yaml`, `SessionRow` (`packages/crm/src/schedule.ts:11-18`) takes
`string | null`, `CampSessionAttributes` is corrected to optional, and `planSessions` writes null.
The user owns the data fix — the real 2024 dates are recoverable and will be entered in Clubspot —
so this is not how those 11 camps get correct dates. It is so the sync tolerates a record not yet
corrected, and does not re-break when the next legacy row surfaces. A skip would instead cascade
into `registration_entries` and cost real registration data, which is the trade #131 was weighing.

_Widening the SDK types breaks two consumers, and step 2 has to fix them._ `tsc --build` fails at
`packages/admin-functions/src/roster.ts:419` and `packages/todo-manager/src/main.ts:75-76`, both
calling `DateTime.fromJSDate(session.get("startDate"))`, which needs a `Date`. Neither is correct
today either: they already receive `undefined` from live data, and `DateTime.fromJSDate(undefined)`
yields an invalid DateTime rather than throwing, so `todo-manager` would already name a project
"Emails <camp> - Invalid DateTime". The type change surfaces a latent bug rather than creating one.
`roster.ts` throws — it renders one session the caller named, and failing loudly beats a roster
against an invalid date. `todo-manager` skips and warns — it loops over every session in a camp, and
one legacy row must not cost the camp its other projects. `admin-functions`' `participants.ts`,
`contacts.ts` and `sessions.ts` are unaffected: they go through `formatDate(date?: Date, ...)`.

**Class B — the skip guard is the primary handler.** The session filter at `main.ts:62` is in place
today and Class B fails anyway, so filtering does not fix it. `planEntryCaps` drops a cap whose
session id is not in the lookup map and warns, rather than throwing. `entry_caps.session_id` is
nullable (`schema.yaml:1335`), but null there means "this cap applies across every session"
(`packages/crm/src/schedule.ts:36`), so writing null would invent a fact. The same guard goes on
`planRegistrationEntries` (`registrations.ts:179`), which has the identical latent failure and where
a skip is real data loss — its warning carries the registration, session and join ids so a dropped
entry is traceable.

This unblocks all 13 camps, and leaves those 13 caps unrepresented in the CRM until someone
backfills the camp. For a deleted session that is permanent. For an archived one, the backfill path
below fixes it once and for good.

**Archived data: filtered in scheduled runs, reachable by CLI.** Two archived filters exist and they
are independent. `discoverCamps` (`packages/clubspot-sync/src/camps.ts:11-12`) filters archived
_camps_; `main.ts:62` filters archived _sessions_. Both stay for scheduled runs — a nightly job
should reconcile the live schedule, not drag every retired session back in.

A new `--include-archived` flag lifts the session filter for one manual run, in the option style of
`main.ts:83-110`. It **requires `--camp`**, the same validation shape `--since` already has
(`main.ts:126-128`), which is also why it needs nothing for archived camps: `--camp` bypasses
discovery entirely (`sync-run.ts:468`), so naming an archived camp already works. It composes with
the existing backfill flags without overlapping them — `--since` widens the registration window,
`--include-archived` widens the schedule fetch, `--dry-run` previews either.

The threading matters for scoping: `fetchCampData`'s query is fixed at `main.ts:58-73` and the
gateway is a module-level constant (`main.ts:75-79`). Build the gateway inside the action with the
flag captured, rather than widening `SyncGateway.fetchCampData` — its arity is guarded on purpose by
`ExactParams` (`sync-run.ts:63-77`).

One backfill is durable, which is what makes this worth building rather than a one-off script.
`planEntryCaps` resolves sessions against the whole CRM `sessions` table, not the current fetch, so
once an archived session has a row, later scheduled runs resolve its caps too. Those sessions then
freeze as of the backfill — normal runs no longer fetch them, so `planSessions` stops updating them
and `planSessionClasses` (`schedule.ts:162`) stops touching their join rows, which is the right
behavior for a retired session and never deletes anything.

**`sessions.archived` becomes a real column,** so a backfilled archived session is represented
honestly instead of looking current. It mirrors `registrations.archived` exactly
(`packages/crm/schema.yaml:3862-3899`): boolean, `default_value: false`, `is_nullable: false`. The
SDK already types the attribute — `CampSessionAttributes` extends `ClubspotAttributes` extends
`ArchiveAttributes` (`packages/clubspot-sdk/src/types.ts:4-8`). That default is also the migration:
every existing `sessions` row was written under the filter, so all of them are genuinely unarchived
and need no backfill.

For the Data Studio, the `sessions` collection meta already carries Directus's archive keys unset
(`packages/crm/schema.yaml:359-380`). Pointing `archive_field` at the new column, with
`archive_value: "true"` / `unarchive_value: "false"`, hides archived sessions from the default list
view for free; anything past that belongs to the queued UX work. One thing to verify rather than
assume: the sync's own `readItems("sessions", { limit: -1 })` (`sync-run.ts:138`) must keep
returning archived rows, or reconciliation would duplicate every archived session.

**Class C residual.** `currency` becomes nullable and `BillingRegistrationAttributes.currency`
(`packages/clubspot-sdk/src/types.ts:147`) optional, since a free registration may carry no currency
even once fetched.

**Partial writes stay.** Directus REST has no cross-collection transaction, so per-camp atomicity is
not reachable without more machinery than this justifies. Both passes are idempotent upserts keyed
on Clubspot ids, and person references are pinned at creation (`sync-run.ts:345-351`), so a
half-written camp converges on the next successful run rather than duplicating. What makes that
acceptable is the warning: without it, "converged" and "gave up on a row" look the same from
outside.

**Recovery needs no backfill.** `watermarkForCamp` (`packages/clubspot-sync/src/sync-log.ts:12-17`)
reads the newest **`ok`** program run, and no camp has one, so every camp's watermark is still the
epoch. The first run after these fixes re-reads every registration from the beginning and reconciles
the full schedule. That only holds while no camp has recorded an `ok` run, so it argues for shipping
these together.

**Deploy order.** `scripts/deploy:7-8` applies `infrastructure` (the job image) before `crm` (the
schema), so between them the new code can run against the old columns. That failure is the same
contained per-camp failure and self-heals the next hour. Dropping NOT NULL and adding a column with
a default are both the safe direction; re-adding NOT NULL later would fail against any null rows
written meanwhile.

## Alternatives

- **Skip dateless sessions instead of nulling the dates** — cascades into `registration_entries`,
  so it drops real registrations to avoid an empty date column.
- **Drop the session filter in scheduled runs** — would resolve the archived half of Class B
  automatically, but drags every retired session into the live schedule on every run. Rejected by
  the user in favour of the CLI backfill.
- **Represent archived sessions without the CLI flag** — a column nothing can populate.
- **Skip archived-session backfill entirely and rely on the guard** — leaves the CRM permanently
  unable to hold a registration entry against a since-archived session, which is real history.
- **Default `currency` to `"usd"`** — the club only transacts in USD, but it fabricates a value in a
  financial table, and it would have masked the unfetched-pointer bug completely.
- **Make a camp atomic** — no cross-collection transaction in Directus REST, and a
  compensating-delete implementation would be more dangerous than the partial writes it replaces.

## Open questions

1. **Archived or deleted?** This now decides how much of Class B a backfill can ever recover, not
   just how it is handled. After step 3 ships, every scheduled run warns with the same session ids
   Cloud Logging shows today (`LsHj9sJxcF` for camp `5OpGvRXbvo`, `GTb86InVCq` for `6pD381jIBl`, and
   so on for the other 11). Re-running one of those camps with `--include-archived --dry-run` after
   step 4 answers it per camp: the warning disappears if the session was archived, and persists if
   it was deleted. Worth doing for one camp before deciding whether to backfill all 13.
2. **Where should skip counts live?** This design logs them (`winston.warn`, the precedent at
   `registrations.ts:52-63`) and adds no counter, so it touches neither `sync-log.ts` nor
   `sync-run.ts`. A durable count means an `items_skipped` column on `sync_program_runs`, which
   overlaps the queued task adding `programs_skipped` / `programs_failed` to `sync_runs` — it should
   ride with that work, not this.
3. **If a fetched billing object still has no currency, is null acceptable in reports**, or does
   finance need a value there?

## Steps

1. ~~**Fetch billing properly.**~~ Landed as `2a416f10`.
2. **Nullable session dates, and the two consumers that blocks (Class A, #131).**
   `CampSessionAttributes.startDate`/`endDate` optional; `sessions.start_date`/`end_date` nullable
   and `required: false` in `packages/crm/schema.yaml`; `SessionRow` takes `string | null`;
   `planSessions` writes null and warns once per dateless session; `roster.ts:419` throws on a
   dateless session; `todo-manager/src/main.ts:75-76` skips and warns. Verify: `just build` across
   the workspace is the actual gate, plus a unit test on `planSessions` and `just directus-local` to
   confirm the applied schema accepts a null date.
3. **Skip unresolvable session references (Class B).** `planEntryCaps` and `planRegistrationEntries`
   drop a row whose session id is not in the lookup map, warning with the owning ids, instead of
   throwing. `requireLookup` stays as it is for program and class references, which are not
   optional. Verify: unit tests for both plan functions asserting the row is absent and the rest of
   the plan is unaffected. Independent of step 2 — order between them is free.
4. **`sessions.archived`, plus `--include-archived` for manual backfills.** Add the column
   (mirroring `registrations.archived`), set the collection's `archive_field` / `archive_value` /
   `unarchive_value` meta, add it to `SessionRow`, map it in `planSessions`, and add the flag —
   requiring `--camp`, with the gateway built in the action so `SyncGateway` is unchanged. Verify:
   unit test that `planSessions` maps both states; a CLI test that the flag without `--camp` errors;
   `just directus-local` to confirm existing rows default to `false` and that a token-authenticated
   `readItems` still returns archived rows. **After step 2**, so a backfill cannot crash on a
   dateless archived session.
5. **Nullable billing currency (Class C residual).** `BillingRegistrationAttributes.currency`
   optional, `registration_billing.currency` nullable and `required: false`,
   `RegistrationBillingRow.currency` takes `string | null`, mapping passes null through. Verify:
   unit test, plus `just directus-local`.
6. **Write the policy down.** One paragraph in `packages/clubspot-sync/README.md` under "Behaviors
   worth knowing before you change this", the flag in its "Verifying and backfilling one camp"
   section, and schema notes in `docs/crm-schema.md` for the new column and the three nullable ones.
   Close #131.

After the deploy, verification is one run: `programsSynced` should reach 38, and any remaining `Camp
sync failed` names a class not covered here. Before it, `--camp <id> --dry-run` against one camp
from each class is the cheap check.

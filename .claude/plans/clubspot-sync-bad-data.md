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
`is_nullable: false` (`packages/crm/schema.yaml:4145`, `:4185`).

**Class B — entry cap on an unresolvable session (13 camps, not filed).** `requireLookup`
(`schedule.ts:21-27`) throws from `planEntryCaps` (`schedule.ts:142`). Each affected camp names
exactly one session id and all 13 are distinct — one bad cap per camp, with any others hidden
behind the throw.

The cause is the archived filter, or a dangling pointer, and the symptoms are identical. Sessions
are fetched with `.notEqualTo("archived", true)` (`packages/clubspot-sync/src/main.ts:62`) while
entry caps come off `campClass.get("entryCapsArray")` unfiltered (`main.ts:66`). The lookup map is
built from the whole CRM `sessions` table, not just this camp's fetch (`sync-run.ts:269`), so an
unresolvable id means that session has **never** been in the CRM. Archived before the sync ever ran,
and deleted in Clubspot leaving a cap pointing at nothing, both produce exactly that. Telling them
apart needs a live Clubspot query, which this session had no credentials for.

**Class C — missing billing currency (14 camps, not filed).** This one is not a bad-data problem at
all. `queryCampEntries` (`packages/clubspot-sdk/src/queries.ts:9-22`) does not
`include("billing_registration")`, so `registration.get("billing_registration")`
(`packages/clubspot-sync/src/registrations.ts:210`) returns an **unfetched pointer**: every `get` on
it returns `undefined`. `centsOrZero` (`:201`) silently turns each amount into `0`, and `currency`
(`:228`) has no fallback, so Directus rejects the row. The zeros are the worse half of the bug — the
400 is the only reason the CRM does not already hold a table of fake zero billing (confirmed:
`registration_billing` is empty today, so there is nothing to clean up). The sibling query
`queryRegistrations` includes it (`queries.ts:36`), as does the admin-functions report
(`packages/admin-functions/src/registrations.ts:66`).

## Approach

**Policy.** A missing scalar makes the column nullable. An unresolvable reference skips the row,
with a warning naming both ids. Never fabricate a value, and never drop a row silently.

**Class A — nullable.** `sessions.start_date` / `end_date` become nullable in
`packages/crm/schema.yaml`, `SessionRow` (`packages/crm/src/schedule.ts:11-18`) takes
`string | null`, `CampSessionAttributes` is corrected to optional, and `planSessions` writes null.
That is what the policy prefers anyway, and it dissolves the cascade #131 worried about: the session
row exists, so entry caps, `session_classes` and `registration_entries` still resolve against it and
no registration is dropped. A skip would have cost registration data to avoid an empty date column.

**Class B — two layers: represent archived sessions, then skip what is still unresolvable.**

_Layer one, the correct representation._ `sessions` gains an `archived` boolean, mapped from
`CampSession.archived`, and the filter at `main.ts:62` goes away so archived sessions are synced
like any other. The SDK already types the attribute — `CampSessionAttributes` extends
`ClubspotAttributes` extends `ArchiveAttributes` (`packages/clubspot-sdk/src/types.ts:4-8`) — so no
type correction is needed here. The column mirrors `registrations.archived` exactly
(`packages/crm/schema.yaml:3862-3899`): `default_value: false`, `is_nullable: false`. That default
is also the migration: existing `sessions` rows were all written under the old filter, so every one
of them is genuinely unarchived and the default backfills them correctly. No manual backfill.

Two consequences to check when implementing. More sessions now arrive, some of which may be
dateless — which is exactly what Class A's nullable dates already handle, so the two compose and
neither needs to know about the other; sequencing Class A first is what makes that true.
`planSessionClasses` (`schedule.ts:162`) also expands over every fetched session, so archived
sessions get their `session_classes` rows too. That is consistent — the session is represented, and
so is what it offered — and the join carries no independent meaning to go stale.

Downstream, a registration entry pointing at a since-archived session now resolves instead of
being dropped. That was the argument for doing this at all, and it holds: `planRegistrationEntries`
(`registrations.ts:179`) looks the session up in the same map, which is built from the CRM
`sessions` table.

For the Data Studio, the `sessions` collection meta already carries Directus's archive keys unset —
`archive_field: null`, `archive_value: null`, `unarchive_value: null`, `archive_app_filter: true`
(`packages/crm/schema.yaml:359-380`). Pointing `archive_field` at the new column, with
`archive_value: "true"` / `unarchive_value: "false"`, hides archived sessions from the app's default
list view for free. That is the whole of the UI concern here; anything beyond it belongs to the
queued UX work. One thing to verify rather than assume: the sync's own reads
(`readItems("sessions", { limit: -1 })`, `sync-run.ts:138`) must keep returning archived rows, or
reconciliation would create duplicates of every archived session on the next run.

_Layer two, the last-resort guard._ The column only rescues caps whose session was archived. A cap
whose session was **deleted** in Clubspot points at nothing any column can hold, so `planEntryCaps`
still drops that row and warns. `entry_caps.session_id` is nullable (`schema.yaml:1335`), but null
there means "this cap applies across every session" (`packages/crm/src/schedule.ts:36`), so writing
null would invent a fact. The same guard goes on `planRegistrationEntries`, which has the identical
latent failure and where a skip is real data loss — its warning carries the registration, session
and join ids so a dropped entry is traceable. The guard stays regardless of how much of Class B the
archived column turns out to fix.

**Class C — fix the fetch; the policy is only the residual guard.** Add
`include("billing_registration")` to `queryCampEntries`, and make `buildRegistrationBillingRow`
refuse an unfetched pointer rather than write zeros. Separately `currency` becomes nullable and
`BillingRegistrationAttributes.currency` (`packages/clubspot-sdk/src/types.ts:147`) optional, since
a free registration may carry no currency even once fetched.

**SDK type corrections are in scope**, in the commit for the class that needs each one. Widening
`startDate`/`endDate` to optional breaks `planSessions`'s compile on its own, so splitting them into
a step of their own would land a commit that does not build.

**Partial writes stay.** Directus REST has no cross-collection transaction, so per-camp atomicity is
not reachable without more machinery than this justifies. Both passes are idempotent upserts keyed
on Clubspot ids, and person references are pinned at creation (`sync-run.ts:345-351`), so a
half-written camp converges on the next successful run rather than duplicating. What makes that
acceptable is the warning: without it, "converged" and "gave up on a row" look the same from
outside.

**Recovery needs no backfill.** `watermarkForCamp` (`packages/clubspot-sync/src/sync-log.ts:12-17`)
reads the newest **`ok`** program run, and no camp has one, so every camp's watermark is still the
epoch. The first run after these fixes re-reads every registration from the beginning and reconciles
the full schedule, which closes the Class C hole — but only because it happens before any camp
records an `ok` run. So no `--since` backfill is needed if these ship together.

**Deploy order.** `scripts/deploy:7-8` applies `infrastructure` (the job image) before `crm` (the
schema), so between them the new code can run against the old columns. That failure is the same
contained per-camp failure and self-heals the next hour. Dropping NOT NULL and adding a column with
a default are both the safe direction; re-adding NOT NULL later would fail against any null rows
written meanwhile.

## Alternatives

- **Skip dateless sessions instead of nulling the dates** — cascades into `registration_entries`,
  so it drops real registrations to avoid an empty column. #131 raised it as the likely answer; it
  is the wrong trade.
- **Drop the `archived` filter without adding the column** — a one-line fix for Class B, but
  retired sessions would then present as current, in a collection documented as the live schedule
  (`docs/crm-schema.md:116`).
- **Add the archived column but keep the skip as the only handling of Class B** — leaves the CRM
  unable to represent a registration entry against a session archived after the fact, which is real
  historical data.
- **Default `currency` to `"usd"`** — the club only transacts in USD, but it fabricates a value in a
  financial table, and it would have masked the unfetched-pointer bug completely.
- **Make a camp atomic** — no cross-collection transaction in Directus REST, and a
  compensating-delete implementation would be more dangerous than the partial writes it replaces.

## Open questions

1. **How much of Class B does the archived column actually fix?** Unknown until it ships, and the
   first run answers it without a separate probe. If archiving was the cause, all 13 camps complete
   and no "unresolvable session" warning appears. If deletion was the cause, the same 13 camps still
   complete — the skip sees to that — but each emits a warning naming the same session id Cloud
   Logging shows today (`LsHj9sJxcF` for camp `5OpGvRXbvo`, `GTb86InVCq` for `6pD381jIBl`, and so on
   for the other 11). A mix gives a subset. If you want the answer before shipping instead, it takes
   one live Clubspot query with credentials I did not have.
2. **Where should skip counts live?** This design logs them (`winston.warn`, the precedent at
   `registrations.ts:52-63`) and adds no counter, so it touches neither `sync-log.ts` nor
   `sync-run.ts`. A durable count means an `items_skipped` column on `sync_program_runs`, which
   overlaps the queued task adding `programs_skipped` / `programs_failed` to `sync_runs` — it should
   ride with that work, not this.
3. **If a fetched billing object still has no currency, is null acceptable in reports**, or does
   finance need a value there?

## Steps

1. **Fetch billing properly.** Add `include("billing_registration")` to `queryCampEntries`
   (`packages/clubspot-sdk/src/queries.ts`), and make `buildRegistrationBillingRow` throw on a
   billing pointer whose data was never fetched instead of writing zeros. Verify: cases in
   `packages/clubspot-sync/test/registrations.test.ts` for a fetched object and an unfetched
   pointer, using the fake-Parse-object pattern at
   `packages/clubspot-sync/test/schedule.test.ts:14-16`.
2. **Nullable session dates (Class A, #131).** `CampSessionAttributes.startDate`/`endDate` optional;
   `sessions.start_date`/`end_date` nullable and `required: false` in `packages/crm/schema.yaml`;
   `SessionRow` takes `string | null`; `planSessions` writes null and warns once per dateless
   session. Verify: unit test on `planSessions`, plus `just directus-local` to confirm the applied
   schema accepts a null date. **Must precede step 3**, which brings in more sessions that may be
   dateless.
3. **Archived sessions become first-class.** Add `sessions.archived` (boolean, `default_value:
false`, `is_nullable: false`, mirroring `registrations.archived`), set the collection's
   `archive_field` / `archive_value` / `unarchive_value` meta, add it to `SessionRow`, map it in
   `planSessions`, and drop `.notEqualTo("archived", true)` from `main.ts:62`. Verify: unit test
   that `planSessions` maps both states and that an archived session still produces
   `session_classes`; `just directus-local` to confirm the applied schema defaults existing rows to
   `false` and that a token-authenticated `readItems` still returns archived rows.
4. **Skip unresolvable session references (Class B's last-resort guard).** `planEntryCaps` and
   `planRegistrationEntries` drop a row whose session id is not in the lookup map, warning with the
   owning ids, instead of throwing. `requireLookup` stays as it is for program and class references,
   which are not optional. Verify: unit tests for both plan functions asserting the row is absent
   and the rest of the plan is unaffected.
5. **Nullable billing currency (Class C residual).** `BillingRegistrationAttributes.currency`
   optional, `registration_billing.currency` nullable and `required: false`,
   `RegistrationBillingRow.currency` takes `string | null`, mapping passes null through. Verify:
   unit test, plus `just directus-local`.
6. **Write the policy down.** One paragraph in `packages/clubspot-sync/README.md` under "Behaviors
   worth knowing before you change this", covering the policy and what `sessions.archived` means,
   and the schema notes in `docs/crm-schema.md` for the new column and the three nullable ones.
   Close #131.

After the deploy, verification is one run: `programsSynced` should reach 38, any remaining `Camp
sync failed` names a class not covered here, and the "unresolvable session" warnings answer open
question 1. Before it, `--camp <id> --dry-run` against one camp from each class is the cheap check.

# @cyc-seattle/clubspot-sync

A Cloud Run job that syncs one Clubspot club's camps, schedule, and registrations into the CRM's
Directus instance (`@cyc-seattle/crm`). Replaces the spreadsheet-backed reports in
`admin-functions` for that data. See issue #70.

## Running locally

Start a local Directus and Postgres with `just directus-local` from the repository root. It
applies `packages/crm/schema.yaml` to a fresh instance.

Then run the CLI against it:

```sh
CLUBSPOT_EMAIL=... CLUBSPOT_PASSWORD=... \
DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=... \
pnpm exec clubspot-sync --club <clubspot-club-id> --dry-run
```

Options:

- `--club <id>` - the Clubspot club id to sync (env `CLUBSPOT_CLUB_ID`)
- `--directus-url <url>` - the base URL of the CRM's Directus instance (env `DIRECTUS_URL`)
- `--directus-token <token>` - a Directus static token for the sync's machine user (env
  `DIRECTUS_TOKEN`)
- `--dry-run` - log the writes the sync would make, without making them
- `--camp <id>` - sync only this camp, bypassing discovery and change detection
- `--since <iso-date>` - backfill: re-read `--camp`'s registrations from this date instead of its
  stored watermark. Requires `--camp`.

Prefer the env vars over `--directus-token` and the Clubspot password flags. A flag value is
visible to anyone on the box who runs `ps` (#49).

## Verifying and backfilling one camp

`--camp <id>` syncs a single camp on demand, bypassing discovery and the backoff check - useful for
checking one camp's data or re-running it right after a mapping fix.

On its own, `--camp` still filters registrations to the camp's stored watermark (its last
successful sync), so re-running it against an already-synced camp only picks up recent changes.
To re-read further back - for a backfill after a mapping fix, say - add `--since <iso-date>` to
widen the registration window to start there instead:

```sh
pnpm exec clubspot-sync --club <id> --camp <camp-id> --since 2026-01-01 --dry-run
```

`--dry-run` is the way to check a backfill before committing to it: it logs the writes without
making them. `--since` only widens the registration read; the schedule pass (`programs`,
`sessions`, `classes`, `session_classes`, `entry_caps`) is already a full reconcile on every run, so
it needs no override.

A successful backfill still records its own `started_at` in `sync_program_runs`, same as any other
run, so the camp's watermark advances from there - it doesn't replay the backfilled window on the
next normal run.

## Shape of the code

Each collection's mapping is a pure plan function, and a thin executor writes the plan. That keeps
almost all of the logic testable with no Directus and no Parse:

- `camps.ts` - discovers the camps for a club.
- `backoff.ts` - decides whether a camp is due for a sync this run.
- `schedule.ts` - plans `programs`, `sessions`, `classes`, `session_classes`, `entry_caps`.
- `people.ts` / `person-sync.ts` - person matching and the `people`/`contacts`/`medical_profiles`
  plan and its executor.
- `registrations.ts` - plans `registrations`, `registration_entries`, `registration_billing`,
  `custom_field_definitions`, `custom_field_responses`.
- `sync-log.ts` - the `sync_runs`/`sync_program_runs` collections and the per-camp watermark.
- `sync-run.ts` - the run loop that ties the above together for one camp.
- `directus.ts` - the Directus REST client.
- `main.ts` - the CLI.

## Behaviors worth knowing before you change this

**Clubspot is the source of truth for schedule and registration columns.** A manual edit to one is
overwritten on the next run that reconciles that row. `people` scalars work differently: `person-sync.ts`
gap-fills them, writing a field only when it's currently null, so a manual edit there survives every
later sync (`docs/crm-schema.md:57-59`). Whether gap-fill is the right model for `people` is open; see #137.

**A person reference is pinned, not gap-filled.** `registrations.person_id` and `contacts.person_id`
are set once, at creation, and never re-resolved. That is what makes a manual merge durable: staff
repoint the FK and delete the duplicate, and no later sync undoes it. See `docs/crm-schema.md` for
the merge procedure.

A session Clubspot has archived syncs like any other, with its row's `archived` written `true`.
Deleting a session in the Data Studio instead sets `archived` on a row Clubspot still reports
unarchived, so the next sync writes `archived: false` and it reappears — intended, since Clubspot
stays authoritative.

**The sync cancels rather than deletes**, except for `session_classes`. A `registration_entries` row
whose Clubspot join object vanished gets `status = cancelled`, not deleted. `session_classes` is a
pure join with no status field of its own, so a class a session no longer offers is removed outright.

**A missing scalar is stored as null; an unresolvable reference is skipped.** `sessions.start_date`/
`end_date` and `registration_billing.currency` are written null rather than fabricated when Clubspot
has nothing. An entry cap or registration entry that points at a session not present in the CRM is
dropped with a warning instead of being written with a guessed reference.

## Backoff

Each run lists every non-archived Clubspot camp for the club - archived sessions within a camp sync
regardless - then decides per camp whether it's due:

- A camp with no sync history, or whose last sync wrote something, is due every run.
- A sync that writes nothing doubles the camp's interval, up to a cap of one week. `skipped` rows
  (a run that found the camp not due) don't count either way - only an actual sync moves the
  backoff.
- A due camp gets a full reconcile, not a partial one, so there's nothing for the interval to miss:
  an entry-cap change (no pointer back to its camp) or a delete (nothing in `updatedAt` reveals one)
  is picked up the same as any other change, without needing to be detected first.
- **Registrations** are still filtered on `updatedAt` between the camp's watermark and the moment
  its own sync starts - not the run's start, since earlier camps in the same run can take real time
  to process. The watermark is per camp: the `started_at` of that camp's most recent successful
  `sync_program_runs` row, or the epoch if there is none - so a camp coming back from a long
  backoff still gets registrations from the entire gap, not just since its last run, and consecutive
  runs' windows tile with no gap between them.

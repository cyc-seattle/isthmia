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
- `--dry-run` - log the writes the sync would make, without making them. Runs every discovered camp
  directly, bypassing the queue - see "Shape of the code" below.
- `--camp <id>` - sync only this camp, bypassing discovery and change detection
- `--since <iso-date>` - backfill: re-read `--camp`'s registrations from this date instead of its
  stored watermark. Requires `--camp`.
- `--seed-contact-points` - one-time migration (step 4): backfills `contact_points` from the
  `participants` mirror, then adds a `staff` row for any `people.email`/`people.phone` with no
  contact point yet. Bypasses the camp sync entirely. Idempotent - safe to rerun - and supports
  `--dry-run`.

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
making them. `--since` only widens the registration read; the schedule pass (`camps`,
`sessions`, `classes`, `session_classes`, `entry_caps`) is already a full reconcile on every run, so
it needs no override.

A successful backfill still advances the camp's stored `synced_through`, same as any other sync,
so it doesn't replay the backfilled window on the next normal run.

## Shape of the code

Each collection's mapping is a pure plan function, and a thin executor writes the plan. That keeps
almost all of the logic testable with no Directus and no Parse:

- `camps.ts` - discovers the camps for a club.
- `backoff.ts` - decides whether a camp is due for a sync this run, and how its watermark and
  backoff state change after one.
- `schedule.ts` - plans `camps`, `sessions`, `classes`, `session_classes`, `entry_caps`.
- `people.ts` / `person-sync.ts` - person matching and the `people`/`contacts`/`medical_profiles`
  plan and its executor.
- `synced-fields.ts` - the one CRM field rule every curated field follows (#137): pure, and used by
  `person-sync.ts` for `people`, guardian/emergency-contact slots, and `medical_profiles`.
- `registrations.ts` - plans `registrations`, `registration_entries`, `registration_billing`,
  `custom_field_definitions`, `custom_field_responses`.
- `sync-run.ts` - `syncCamp`, one camp's full reconcile, and `runSync`, the job entry point.
  A normal run discovers every camp and enqueues one `sync_camp` task per camp onto
  `@cyc-seattle/directus`'s queue, which drives each one on its own retry schedule, isolated from
  its siblings' failures. `--camp` and `--dry-run` bypass the queue for a direct, synchronous
  reconcile instead - useful for a one-off check, and necessary for `--dry-run`, which never
  persists the tasks the queue would otherwise need to drive itself.
- `main.ts` - the CLI.

## Behaviors worth knowing before you change this

**Clubspot is the source of truth for schedule and registration columns.** A manual edit to one is
overwritten on the next run that reconciles that row. `people`, `medical_profiles`, and a
guardian/emergency contact's own `people` row follow one different rule instead (#137, `synced-fields.ts`):
the newest linked participant's form answer wins, and a staff edit holds until Clubspot sends
something new. `person-sync.ts` reads `base` (what the mirror held last time) and `v` (what
Clubspot sends now) for every curated field; `v` equal to `base` writes nothing, `v` different from
`base` writes `v` and counts a replaced staff edit if the CRM value wasn't `base` or null, and a
null `v` is never written. Only the newest registration linked to a person may write at all — an
older one's form never overwrites a newer one's — and a participant's first mirror write only fills
null CRM columns, since there's no prior answer yet to compare against. See `docs/crm-schema.md` for
the same rule described from the schema side.

**Promoted fields follow the same one CRM field rule, in two passes.** A promoted `people` column
(`school` today) is written per registration, inside the camp loop: `custom_field_responses` is
itself the mirror here, so `base` is the response's own stored value before this run's write, `v`
is what Clubspot sends now, gated on the same newest-linked-participant check as `people` and
`medical_profiles`. `promotePeopleFields` then runs once more, at the end of every run across every
camp, as a fallback gap-fill: it only fills a column still null, for a registration the
per-registration pass didn't reach this run - one outside every camp's watermark, say - by ranking
every camp's responses for a person: non-archived before archived, then most recent, with a stable
tiebreak. Label matching normalizes punctuation and case, so `Race / Ethnicity` and `Race/Ethnicity`
match without listing both. Nothing promotes until the target's `promoted_fields` row exists — it's
created by hand, not by Pulumi.

**A person reference is pinned, not gap-filled.** `participants.person_id` and `contacts.contact_id`
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

**A value the SDK types as required, but finds absent, means the SDK's model of Clubspot is wrong -
the sync throws rather than inventing one.** The camp's sync fails, is logged, and counts toward
`runSync`'s `campsFailed`. This covers an unrecognized registration status, a registration
missing `status` or `confirmed_at`, a participant with no first name (`people.first_name` isn't
nullable, and an empty string would let the person matcher merge unrelated nameless people), and a
billing pointer that was never fetched. In a normal (queued) run, the queue also retries the
camp's task later on its own schedule - see Backoff below for how that's a different concern
from the camp's own polling cadence.

## Backoff

Each run lists every non-archived Clubspot camp for the club - archived sessions within a camp sync
regardless - then decides per camp whether it's due:

- A camp with no sync history, or whose last sync wrote something, is due every run.
- A sync that writes nothing doubles the camp's interval, up to a cap of one week. This state
  lives on the camp row itself - `synced_through` and `quiet_runs` - not in a run log, so a
  camp that was never due for a run is never touched and never appears in one.
- A due camp gets a full reconcile, not a partial one, so there's nothing for the interval to
  miss: an entry-cap change (no pointer back to its camp) or a delete (nothing in `updatedAt`
  reveals one) is picked up the same as any other change, without needing to be detected first.
- **Registrations** are still filtered on `updatedAt` between the camp's watermark and the
  moment its own sync starts - not the run's start, since earlier camps in the same run can take
  real time to process. The watermark is `camps.synced_through`, advanced to that instant on
  every successful sync whether or not it wrote anything, or the epoch if the camp has never
  synced - so a camp coming back from a long backoff still gets registrations from the entire
  gap, not just since its last run, and consecutive syncs' windows tile with no gap between them.
- This is a different question from the queue's own `run_after`: `run_after` is "retry this failed
  task later"; this is "this camp has changed nothing for N runs, so poll it less often". A
  failed sync never reaches the code that writes `synced_through`/`quiet_runs`, so a failure has no
  effect on either one - the queue's retry schedule covers it instead.
- Every run re-enqueues every due camp, but `@cyc-seattle/directus`'s queue carries a task's
  `attempts` and `last_error` forward as long as it isn't `done` or `cancelled`, so a camp
  failing every night stays visibly at that count instead of resetting to zero each run. Once
  `attempts` reaches `max_attempts`, the queue sets `needs_attention` on the row but keeps retrying
  it on its normal schedule - a stuck camp must self-heal once the underlying Clubspot outage
  clears, not sit parked until a human notices and re-enqueues it by hand.

# Per-registration contact-sharing opt-in

## Context

The #166 opt-in is per person and acts per family today. The user wants it per registration.

- `people.share_contact` (`packages/crm/schema.yaml:1690`) holds it. Opting a child in shares every
  guardian of that child (`SHARED_GUARDIAN_LINK`, `packages/infrastructure/src/crm/community-rules.ts:86`).
- The portal shows one family toggle and PATCHes every row in `familyIds`
  (`packages/portal/src/roster/model.ts:222`, `browser.ts:219-231`). `selfUrl` (`browser.ts:111`)
  adds any row whose email matches the viewer, with no Adult check. The `family` policy
  (`community-rules.ts:42`, `:200`) denies a minor's own row. So a child who shares a parent's
  email, or a teen with their own email, shows in the toggle and then fails the PATCH.
- The merge fills a null `share_contact` from a duplicate, but a keeper's `true` beats a
  duplicate's `false` (`packages/clubspot-sync/src/merge.ts:62`, `test/merge.test.ts:381`).
- `communityContactsEnabled` (`packages/infrastructure/src/crm/index.ts:306`) is `true` in
  `packages/infrastructure/src/crm/Pulumi.prod.yaml`. So families can toggle in production today,
  and `people.share_contact` has real values.
- A promoted field can land only on `people`. `PROMOTABLE_PERSON_FIELDS` is `["school"]`
  (`packages/clubspot/src/promoted-fields.ts:7`). `planPromotedFieldSync` returns a `people`
  patch (`packages/clubspot-sync/src/promoted-fields.ts:173`). `sync-run.ts:851` writes it only for
  the person's newest registration. `SyncedFieldValue` has no boolean
  (`packages/clubspot-sync/src/synced-fields.ts:12`).
- Each registration's custom-field answers are already stored per registration, in
  `custom_field_responses` (`sync-run.ts:803-817`). `planRegistrations` writes only the keys
  `buildRegistrationRow` returns (`registrations.ts:96-105`, `schedule.ts:43`). A new
  `registrations` column is never overwritten by the registration pass.

## Approach

### Data

Add `registrations.share_contact`, a nullable boolean, to `packages/clubspot/schema.yaml`. Null
means "not answered" and counts as not shared. A Clubspot answer is per participant, and
`registrations.participant_id` is unique, so the registration is the right row. A
`registration_entries` row is one session, not one answer.

Drop `people.share_contact` without migrating its values (Step 6). Step 2 opts in the Fall
double-handed and single-handed teams by hand instead.

### Sync: a registration-level promoted field

`promoted_fields.target_field` gains a `share_contact` choice. A new
`PROMOTABLE_REGISTRATION_FIELDS = ["share_contact"]` sits beside the person list.
`buildTargetByDefinitionId` returns either kind of target.

A new pure function, `planRegistrationPromotedFieldSync`, plans the `registrations` patch from
three inputs:

- the registration's own raw answers
- its stored `custom_field_responses` (the `base`)
- its current `share_contact`

It calls `planSyncedField` with no fallback base and no newest-registration gate. Each
registration answers only for itself. "Yes" and "No" are parsed case-insensitively. Any other
answer is counted and logged, and is not written. `SyncedFieldValue` gains `boolean`.

The end-of-run gap-fill (`planPromotedFields`) also fills a null `registrations.share_contact` from
that registration's own stored answer. This covers registrations synced before staff added the
`promoted_fields` row.

**#171.** #171 no longer blocks the opt-in.

- Each season's registration is a new row with a null column and no stored answer. So its first
  answer always lands, even after a portal edit on last season's row.
- Inside one registration, any changed Clubspot answer is `v ≠ base`, so it is written over a
  portal edit.
- The only edit lost is a Clubspot re-save with the same answer. That is not a new choice.

#171 stays open for the person-level fields.

### Who sees an opted-in registration's contacts

Recommendation: everyone who sees the person through that registration's entries. That is the
program-wide `TEAM_ENTRY` scope that the `names` policy already uses (`community-rules.ts:48`).
A class-only scope would make `contacts` narrower than `names`, and it would need a new filter.

The `contacts` policy replaces `share_contact` on `people` with one filter, used in both branches:

```ts
const OPTED_IN_REGISTRATION = { _and: [{ share_contact: { _eq: true } }, { registration_entries: TEAM_ENTRY }] };
const OPTED_IN_TEAMMATE = { participant_links: { registrations: OPTED_IN_REGISTRATION } };
```

The relational depth does not change, because the opt-in moves from the start of the path to a
hop the path already crosses. If A1's registration in P is opted in and its registration in Q is
not, a viewer in Q gets no contact.

**Guardians (finding 4).** The opt-in shares every guardian linked to the child. `contacts` rows
carry no registration (`packages/crm/schema.yaml`, collection `contacts`), and the child's
registration is the one answer the family gave. See Open questions.

### Portal toggle and the `family` policy (finding 2)

The write target becomes the registration. With `WRITABLE = { _and: [{ camp_id: ACTIVE_CAMP },
{ participant_id: { person_id: FAMILY_SELF } }] }`, the `family` policy becomes:

| Collection      | Action | Fields                                       | Filter                       |
| --------------- | ------ | -------------------------------------------- | ---------------------------- |
| `registrations` | read   | `id, camp_id, participant_id, share_contact` | `WRITABLE`                   |
| `registrations` | update | `share_contact`                              | `WRITABLE`                   |
| `participants`  | read   | `id, person_id`                              | `person_id` is `FAMILY_SELF` |
| `people`        | read   | `id, first_name, last_name`                  | `FAMILY_SELF`                |

The `people` update rule goes away. So does the `family` policy's `contacts` read, because the
toggle no longer derives its targets from guardian links.

The read and the update use one filter. The page must show only rows from the `family` read, not
rows from the `names` read of `registrations` (`id, participant_id`). The page cannot repeat
`FAMILY_SELF` in a query, because no policy grants `date_of_birth`. Instead, only `family` grants
`registrations.camp_id`, which is NOT NULL. A row with a null `camp_id` came from `names`, and the
page drops it. This uses the same per-policy field scoping the `names`/`contacts` split already
depends on. A comment on the rule must say that no other policy may grant `camp_id`.

The page shows one checkbox per writable registration, labeled with the first name and camp name.
It shows no checkbox when there are none. Results:

- A parent and child who share one email: the child's registration matches through the guardian
  branch, so the parent sees it and can update it.
- A teen who signs in with their own email: the teen is not Adult, so they see no checkbox. Their
  guardian can update the registration.

### Removing the board switch (finding 3)

Delete `communityContactsEnabled` (`index.ts:302-309`), its key in `Pulumi.prod.yaml`, the
"board-approval gate" text in the `contacts` description (`community-rules.ts:157`), and
`docs/manual-setup.md:136-143`. The `contacts` policy then always applies. The roster's
`email,phone` fields (`browser.ts:97`) are always granted.

For a teammate who has not opted in, Directus returns `email` and `phone` as null. The roster
shows the name and school with no contact line. It does not show a "not shared" label, because
that would tell other families who declined.

### Merge (finding 1)

This finding is moot. `share_contact` leaves `PERSON_SCALAR_FIELDS` and `MERGE_PERSON_FIELDS`
(`merge.ts:62`, `:80`). A merge moves participants, so each registration keeps its own value.

### ACTIVE_CAMP

`WRITABLE` and `OPTED_IN_REGISTRATION` use the shared `ACTIVE_CAMP` constant
(`community-rules.ts:20`), so they keep the separate date fix. `entriesUrl` in `browser.ts:90`
repeats the literal. Check that the fix covered that copy too.

## Alternatives

- **Keep `people.share_contact` and fix the merge and toggle.** The user decided on per
  registration.
- **One family checkbox that writes every writable registration.** It hides which registration is
  shared, and per-registration consent is the point.
- **Ask Directus per item (`/permissions/me/registrations/:id`).** It is exact, but it costs one
  request per candidate row. The `camp_id` signal costs one request.
- **Put the opt-in on `registration_entries`.** Clubspot asks the question once per registration,
  not once per session.

## Decisions

- **Share scope:** program-wide, as `TEAM_ENTRY` does today.
- **Guardians:** one registration's opt-in shares every guardian of the child.
- **Existing values:** dropped, not migrated.

## Steps

1. `clubspot` schema: add `registrations.share_contact`. Add the `share_contact` choice to
   `promoted_fields.target_field`. Update `RegistrationRow` and `PROMOTABLE_REGISTRATION_FIELDS`.
   Deploy.
2. No migration: existing `people.share_contact` values are dropped in Step 6, and everyone starts
   unanswered. Instead, write a hand-run SQL step that opts in the registrations of the Fall
   double-handed and single-handed teams. The user runs it with `gcloud sql connect` after Step 1
   deploys.
3. `clubspot-sync`: boolean `SyncedFieldValue`, the Yes/No parser,
   `planRegistrationPromotedFieldSync` with its `sync-run.ts` call, and the gap-fill extension. Add
   unit tests for each, and for "the registration pass leaves `share_contact` alone".
4. `infrastructure`: rewrite the `contacts` and `family` policies, and remove
   `communityContactsEnabled` and its docs. Update the integration test:
   - Move every fixture's opt-in to its registration. Give A1 a second, opted-out registration in
     Q. `e@` gets no Guardian A contact, and `b@` still does.
   - Add `f@`, a parent whose minor F1 shares the email, and `t@`, a minor with their own email,
     both in P.
   - For every login, assert that the toggle's read returns exactly the registrations that a PATCH
     of `share_contact` accepts. Try every fixture registration, then revert it.
   - Finding 5: as `a@`, request `people` with `filter[email][_starts_with]=b1`, then
     `filter[phone][_nnull]=true`, then `search=b1@`. Assert that no B1 row comes back. If a check
     fails, stop and report. Do not ship `contacts` until a design fixes it.

   Run `just directus-community-test`. Do not deploy before Step 5.

5. `portal`: one checkbox per writable registration, taken from the `family` read with null
   `camp_id` rows dropped. Delete `familyIds`, `selfUrl`, and `guardianLinksUrl`. Update
   `test/roster-model.test.ts`. Deploy Steps 4 and 5 together.
6. `crm` schema: drop `people.share_contact`. Remove it from `PersonRow`
   (`packages/crm/src/people.ts:17`), `merge.ts`, `people.ts:497`, and the merge and audit tests.
   Deploy.
7. Docs: `docs/crm-schema.md`, the clubspot and clubspot-sync READMEs, and
   `.claude/plans/community-roster.md`. That doc's opt-in section, launch prerequisite, and
   Steps 12, 15, and 16 now point here.

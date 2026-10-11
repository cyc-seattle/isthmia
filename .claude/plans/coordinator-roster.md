# Parent Coordinators see their program's full roster

## Context

A Parent Coordinator helps run a program, and needs every family's contact details for it. The
roster on `cycsail.team` shows a guardian's email and phone only once that child's registration has
opted in (`SHARED_GUARDIAN_LINK`, `packages/infrastructure/src/crm/community-rules.ts:99`), and it
shows any roster at all only to a viewer who acts for a confirmed entrant in the program
(`TEAM_ENTRY`, `community-rules.ts:54-78`). A coordinator with no child in the program sees
nothing.

The mapping already exists. `program_role_assignments` links `person_id`, `program_id`, and
`program_role_id`, with optional `starts_on`/`ends_on` (`packages/crm/schema.yaml:117-176`,
`:1734-1960`). Staff enter it by hand. No column is needed.

A filter cannot reach it yet, though. Every relation on `program_role_assignments` has
`one_field: null` (`schema.yaml:2283-2345`), so neither `programs` nor `people` has a reverse field
to traverse. The roster rules always reverse a relation through an o2m alias
(`programs.classes`, `packages/clubspot/schema.yaml:4885`, `:5425-5434`).

## Approach

### Schema: one alias, no column (`crm`)

Add `programs.role_assignments`, an o2m alias that reverses `program_role_assignments.program_id`.
That means one alias field entry plus `one_field: role_assignments` on the relation at
`schema.yaml:2304-2324`. `crm` owns both collections, so the field is not an extension. Apply adds
no column and renames nothing. gsuite-sync's `readItems("programs")` (`packages/gsuite-sync/src/run.ts:77`)
will also return an array of ids in the new field, which it ignores.

### Rules: two new Community policies (`infrastructure`)

New filters go in `community-rules.ts`, reusing `ME`, `ACTIVE_CAMP`, and `ADULT`:

```ts
export const PARENT_COORDINATOR = "Parent Coordinator";

/** A `programs` row the signed-in user coordinates today. */
const COORDINATED_PROGRAM = {
  role_assignments: {
    _and: [
      { person_id: ME },
      { program_role_id: { name: { _eq: PARENT_COORDINATOR } } },
      { _or: [{ starts_on: { _null: true } }, { starts_on: { _lte: "$NOW" } }] },
      { _or: [{ ends_on: { _null: true } }, { ends_on: { _gte: "$NOW(-36 hours)" } }] },
    ],
  },
};
const COORDINATED_ENTRY = {
  _and: [
    { status: { _eq: "confirmed" } },
    { class_id: { camp_id: ACTIVE_CAMP } },
    { class_id: { program_id: COORDINATED_PROGRAM } },
  ],
};
const COORDINATED_PARTICIPANT = { participant_links: { registrations: { registration_entries: COORDINATED_ENTRY } } };
const COORDINATED_GUARDIAN_LINK = {
  _and: [{ relationship_type: { _eq: "guardian" } }, { subject_id: COORDINATED_PARTICIPANT }],
};
```

The date window matches the one gsuite-sync already applies to the same rows
(`packages/gsuite-sync/src/membership.ts:10-12`). The `schema.yaml` note says a row past `ends_on`
is kept, not deleted. Without the window, a coordinator would keep access after staff end the
role.

There are two policies, not one. `DirectusPermissionRule` allows one row per (policy, collection,
action) (`packages/infrastructure/src/directus/client.ts:193-212`), and `people` needs two reads
with different fields. A single read would expose a minor's own email, which the rules never do
(`community-rules.ts:178`).

| Key                    | Collection             | Fields                                      | Filter                                                                                          |
| ---------------------- | ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `coordinator-names`    | `people`               | `id, first_name, last_name, school`         | `COORDINATED_PARTICIPANT`                                                                       |
|                        | `registration_entries` | `id, status, class_id, registration_id`     | `COORDINATED_ENTRY`                                                                             |
|                        | `registrations`        | `id, participant_id` (never `camp_id`)      | `{ registration_entries: COORDINATED_ENTRY }`                                                   |
|                        | `participants`         | `id, person_id`                             | `{ registrations: { registration_entries: COORDINATED_ENTRY } }`                                |
| `coordinator-contacts` | `people`               | `id, first_name, last_name, email, phone`   | `_or: [{ contact_for: COORDINATED_GUARDIAN_LINK }, { _and: [COORDINATED_PARTICIPANT, ADULT] }]` |
|                        | `contacts`             | `subject_id, contact_id, relationship_type` | `COORDINATED_GUARDIAN_LINK`                                                                     |

Both attach to the Community role through the existing loop (`packages/infrastructure/src/crm/index.ts:305-325`,
which already `dependsOn` the schema). The only edits there are to widen the `key` union
(`community-rules.ts:115`) and fix the "three policies" comment (`index.ts:302`). The new rules
grant no read on `program_role_assignments` or `program_roles`. The filter traverses them without
that, just as `ME` already traverses `people.email`.

### The five questions

1. **Role by name, not by id.** `program_roles` rows are hand-entered and not managed by Pulumi, so
   a fixed uuid would differ across prod, `just directus-local`, and the integration test. It would
   then need a stack config value and its own test setup. A rename fails closed: coordinators lose
   access and nobody gains it. Only staff can write the table, so a duplicate name is only a staff
   mistake. The implementer comments `PARENT_COORDINATOR` to say that the role is matched by name.
2. **Scope.** Yes, the names rules need their own coordinator branch. That is the
   `coordinator-names` policy, so `TEAM_ENTRY` stays as it is. Everything is limited to confirmed
   entries in an active camp, as the existing rules are.
3. **Shared email.** This does not matter. Directus users are unique by email, so a child who
   signs in with the family's shared address is the same viewer as the coordinator parent. Inbox
   control is the credential by design. An `ADULT` guard on the assignment's person would break
   the common case. Clubspot gives guardians no date of birth
   (`packages/clubspot-sync/src/people.ts:291-322`), and a null date fails `ADULT`
   (`community-rules.ts:23-25`). `COORDINATED_PROGRAM` uses the shared `ME`, so it will pick up the
   `contact_points` change in `.claude/plans/community-email-identity.md` with no further work.
4. **Portal.** The only client gate that hides data is `guardianContactsByChild`'s opt-in check
   (`packages/portal/src/roster/model.ts:130`). It applies only to the viewer's own writable
   children, because `writableOptInStatus` skips any registration with a null `camp_id`
   (`model.ts:104`). The extra rows for other families come back with a null `camp_id`, so they
   pass through `buildRoster` (`model.ts:179-184`) and `renderMember` (`render.ts:79-87`) untouched.
   That leaves one gap. A coordinator whose own child has not opted in would not see their
   co-guardian. The fix is to skip a link only when the gate fails **and** the server returned no
   email or phone for that guardian. A non-coordinator gets only names for their own guardians
   from `family` (`community-rules.ts:220-225`), so their view is unchanged.
5. **Directus limits.**
   - Permissions from several policies combine as a union.
   - Directus 11 and later returns a policy's fields only for rows that match that policy's filter.
     The `names`/`contacts` split already depends on this, and the integration test covers it.
   - No policy may grant `registrations.camp_id`, because the portal uses it to recognise the
     viewer's own rows (`community-rules.ts:209-210`). `coordinator-names` does not grant it.
   - The deepest new path is about 10 hops, through `contact_for`, `subject_id`, and on to
     `program_role_id.name`. That is shallower than the existing 12 and 14 hops, which work with
     no `MAX_RELATIONAL_DEPTH` override.
   - Relational permission filters need the license (`community-rules.test.ts:24-32`).
   - The portal must not add a client-side filter on a field Community cannot read. A filter like
     that returns a 400, so it rules out detecting a coordinator from the browser.

### Verification

`packages/infrastructure/integration/community-rules.test.ts` already applies every entry in
`communityPolicies` (`:141-151`). New fixtures and checks:

- Coordinator K: a guardian-only person with a null date of birth, holding a Parent Coordinator
  assignment on P. K sees B1's and F1's guardians, both of whom have `share_contact` null. K sees
  adult C's own email, but never B1's own email. K sees nothing from Q or from the ended camp. K's
  `registrations` rows come back with a null `camp_id`.
- A person holding a different role on P, and a person whose Parent Coordinator assignment has an
  `ends_on` in the past. Each sees nothing beyond their own family's view.

Do not run it until #172 is fixed: each run uses up a Directus license activation. Until then,
the rules are checked only by type-check and unit tests. Staff accounts use the Staff role, so
after deploy only a real coordinator signing in can check production.

## Alternatives

- **`$FOLLOW(program_role_assignments, program_id)` instead of an alias.** This avoids the schema
  edit. Nothing in the repo uses it, and it has not been checked on Directus 12.3.1. The #166 rules
  used aliases.
- **Add a coordinator `_or` branch to `TEAM_ENTRY`.** This would be a smaller diff, but it reworks
  the rules the `names` and `contacts` policies share, against the stated preference.
- **One `coordinator` policy.** It needs two `people` reads, which is not possible, or one read
  that leaks a minor's email.
- **A fixed `program_role_id`.** Rejected under question 1.

## Decisions

1. The prod role is named exactly `Parent Coordinator` (checked 2026-10-10).
2. No coordinator label on the page for now.

## Steps

1. `crm`: add the `programs.role_assignments` o2m alias to `packages/crm/schema.yaml`.
2. `infrastructure`: add the `coordinator-names` and `coordinator-contacts` policies to
   `community-rules.ts`, the integration fixtures and checks above, the `index.ts:302` comment,
   and one **Coordinators** bullet in `docs/crm-schema.md`'s Community section.
3. `portal`: relax the `guardianContactsByChild` gate in `model.ts` as in question 4, with a
   `packages/portal/test/roster-model.test.ts` case. Update the `RawRegistration` comment
   (`model.ts:32-34`) so it names `coordinator-names` as another read that has no `camp_id`.

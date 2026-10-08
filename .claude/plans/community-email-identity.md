# Community identity by current email, and the roster filter fix

## Context

Authentik signs a person in by Google or by an emailed link. Control of the inbox is the
credential. The Community rules already use it: `ME` compares `people.email` to
`$CURRENT_USER.email` (`packages/infrastructure/src/crm/community-rules.ts:16`). This doc keeps
email as the identity. It fixes two problems.

1. **`ME` reads one address per person.** `contact_points` holds every email a form or staff gave
   for a person (`packages/crm/schema.yaml:5-25`). A person who signs in with a second address
   matches nobody. `people.directus_user_id` stays as it is, unused.
2. **The roster returns 400 for Community.** `FAMILY_REGISTRATIONS_FILTER` and
   `VIEWER_SELF_FILTER` (`packages/portal/src/roster/model.ts:209-231`, sent at
   `browser.ts:111-135`) filter on `people.date_of_birth` and `my_contacts`. Community cannot read
   either. Staff can, and Staff needs the filter, because Staff reads every registration.

What `contact_points` stores:

- `kind` (`email`/`phone`), `normalized` (trimmed and lowercased, `packages/clubspot-sync/src/people.ts:24-30`),
  `source` (`form`/`staff`), and `last_seen_at`, which is nullable.
- A `form` row gets `last_seen_at` when it is created, and again each time a synced form gives the
  same value (`packages/clubspot-sync/src/contact-points.ts:107-123`).
- A `staff` row is a hand entry, or a primary email the migration seeded (`contact-points.ts:194-229`).
- No field marks an address as retired. When a value on `people` is replaced, the old value is
  kept as a row (`packages/clubspot-sync/src/person-sync.ts:140`).

## Approach

### 1. Identity rule (`community-rules.ts`)

```ts
const CURRENT_EMAIL_POINT = {
  _and: [
    { kind: { _eq: "email" } },
    { normalized: { _eq: "$CURRENT_USER.email" } },
    { _or: [{ source: { _eq: "staff" } }, { last_seen_at: { _gte: "$NOW(-1 year)" } }] },
  ],
};
const ME = { _or: [{ email: { _eq: "$CURRENT_USER.email" } }, { contact_point_links: CURRENT_EMAIL_POINT }] };
```

`contact_point_links` is the reverse of `contact_points.person_id` (`schema.yaml:2346-2360`).

How stale addresses are excluded:

- **No clean "current" flag exists.** `last_seen_at` is the nearest signal. It records when a form
  last gave the address, not whether the person still uses it.
- **A `form` row counts for one year after it was last seen.** A roster shows only active camps,
  and an active camp needs a registration this season. Syncing that registration updates
  `last_seen_at` on every address its form gave. So a current family's addresses always count,
  and an address that was only on old forms stops counting within a year.
- **A `staff` row always counts.** Staff remove a row by deleting it. Seeded `staff` rows include
  some old primary emails. That is accepted, because an address that went to a new owner is rare.

How each policy behaves when `ME` matches more people:

- **`ACTS_FOR` and `TEAM_ENTRY`:** a login sees the teams of every person who has its address.
- **`FAMILY_SELF`:** a parent and child who share an address both match `ME`, as they do today.
  The child is reached through `GUARDIAN_OF`. `ADULT` keeps the child out of the self branch, so a
  minor cannot use a matching address to edit their own toggle. This is the same as today.
- **`contacts` policy:** does not use `ME`, so nothing changes.

**Risk:** a parent can enter their own email in an emergency-contact slot. That attaches the
address to another adult's row, so the parent can then read that adult's teams and toggle their
`share_contact`. `ADULT` does not stop this. `people.email` has the same risk today. Old
addresses make it more likely. See Open questions.

The harness must confirm one thing: that a permission filter can go through `contact_points`
when the role has no read on `contact_points`. Today Community has none
(`packages/infrastructure/integration/community-rules.test.ts:495`).

### 2. Roster fix (`packages/portal/src/roster/`)

The Staff filter cannot avoid fields that Community cannot read. `ME` needs `people.email` and
`contact_points`. For Community to send it, Community would need:

- a read grant on its own identity data, and
- read on the guardian's own `people` row, which `FAMILY_SELF` leaves out when the date of birth is
  null.

It would also copy the identity rule into the browser. So the filter goes to Staff only:

- **Detect Staff.** Read `GET /permissions/me`. Send the family filter only when `registrations`
  read is unrestricted. This needs no grant and no role id in the page. The harness must confirm
  the response shape.
- **Community sends no family filter.** The `family` policy already scopes the result.
- **Staff filter.** It is `ACTIVE_CAMP` and `person_id` in `ME` or `GUARDIAN_OF`, with the new
  `ME`. It has no `ADULT`: the server applies that for Community, and Staff can write every row.
- **Delete `VIEWER_SELF_FILTER`.** Derive "self" in `shareToggleRows` instead. A writable person
  who is the subject of a readable guardian link is a child. Every other writable person is self.

Deriving self needs one grant. The `family` policy reads `contacts` rows that match
`MY_GUARDIAN_LINK` (`subject_id, contact_id, relationship_type`). These are the viewer's own links
to their own children, and the policy already returns those children's rows. Staff already reads
all of `contacts`.

The grant also lets the unfiltered contacts read (`browser.ts:127`) return the viewer's own links
before any opt-in. To keep today's behavior, `guardianContactsByChild` shows a link whose subject
is writable only when one of that subject's writable registrations has `share_contact` true. Other
families' links are readable only after an opt-in, so they are unaffected.

### 3. The `ungood@` login

`ungood@` is a hand-made Staff login (`packages/infrastructure/src/infrastructure/directus-roles.ts:109`).
No `people` row and no `contact_points` row has that address. After this change it sees:

- every active camp's roster, because Staff reads all entries, and
- no share toggles, because the Staff filter matches nobody.

To fix this at the source, add a `staff` email `contact_points` row for `ungood@onetrue.name` on
the user's `people` row. That is a data edit, not code.

### Testing

Extend `just directus-community-test` (`community-rules.test.ts`):

- **Multi-address.** A person has a recent `form` point and a `staff` point with a null
  `last_seen_at`. Both logins see the same rows.
- **Stale.** A `form` point last seen two years ago matches nothing.
- **Shared email.** The existing fixtures (guardianA/A1, guardianF/F1) still pass, including the
  `ADULT` guard.
- **Portal requests.** Run the portal's exact Community requests as a Community login:
  `/permissions/me`, entries, people, contacts, registrations, and participants. Each returns 200
  with the expected rows.
- **Own guardian links.** A login reads its own guardian links and still not another family's
  unshared ones.

Copy the requests into the test with a pointer to `model.ts`. `infrastructure` does not import
`portal`. If the harness has no Staff role, unit tests cover the Staff filter's shape, and the
`ungood@` sign-in checks it for real.

Portal unit tests cover the self derivation, the guardian-card rule, and the per-role choice of
request.

After deploy, sign in at `cycsail.team` as `jason@` with the email link. Check the family roster
and the toggles. Then sign in as `ungood@` with Google, after the data edit above.

## Alternatives

- **An FK from login to person.** Rejected. One person signs in with several addresses, and one
  address can belong to a parent and a child. That makes the relation many logins to many people,
  not one FK. It also needs a linking pass and a field on a system collection. Email already is
  the credential, so a link adds machinery and does not make anyone more certain who signed in.
- **Grant Community enough to send the Staff filter.** This needs identity grants, plus read on the
  guardian's own row. It also copies `ME` into the browser, where it can drift.
- **Send the filter, then retry without it on 400.** This hides every real 400.

## Open questions

1. **Should `form` contact points count as identity, or only `staff` ones?** `form` rows (within
   one year) cover a family's other addresses with no staff work. They also carry the
   emergency-contact risk above. With `staff` only, each extra address needs a hand entry.
   Recommended: count both.

## Steps

1. **Identity rule.** Widen `ME` in `community-rules.ts`. Add the multi-address, stale, and
   shared-email tests. Update the Community section of `docs/crm-schema.md`. Deploy `crm`.
2. **Own guardian links.** Add the `family` read on `MY_GUARDIAN_LINK` `contacts` rows, with its
   harness test. Deploy `crm`.
3. **Portal.** Add the Staff detection, the Staff-only filter, the self derivation, and the
   guardian-card rule. Add the unit tests and the harness test of the portal's Community requests.
   Deploy.
4. **Verify.** Add the `ungood@` contact point by hand. Sign in as `jason@` and as `ungood@`.

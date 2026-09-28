# Community roster on Authentik

## Context

Race team families cannot find the other people on their team (#166). The CRM already holds the
data, but no family can log in, and no permission rule lets anyone read another family's rows.

- Every request to `cycsail.team` goes through oauth2-proxy, and only `all@` members pass
  (`packages/substrate/deploy/Caddyfile:18-43`, `docker-compose.yml:38`).
- The Guardian policy lets a guardian read only their own minors (`guardianFilter`,
  `packages/infrastructure/src/crm/index.ts:129-150`). The Guardian role has no login
  (`packages/infrastructure/src/infrastructure/directus-roles.ts:44-58`).
- `people.directus_user_id` is unique (`packages/directus/schema.yaml:1262`). A family commonly
  shares one email across a parent and a child, so it cannot be the login link.
- `people.email` is raw Clubspot text with mixed case (`packages/clubspot-sync/src/people.ts:255`).
  It is still each person's one primary email after #167. Every other known address is in
  `contact_points`. Directus `_eq` is case-sensitive on Postgres, and `docs/crm-schema.md` notes
  that the filters offer only `_eq` and `_icontains`. `_icontains` is a substring match, so it is
  not safe for identity.
- Since #167, a person reaches a registration through a participant:
  `registrations.participant_id` → `participants.person_id` → `people`
  (`packages/clubspot/schema.yaml:5253`, `:5211`). `people.participant_links` reverses the second
  hop. Nothing reverses the first: `registrations.participant_id` has no `one_field`.

**Email deliverability is broken today.** `cyccommunitysailing.org` publishes two SPF records
(`include:_spf.google.com` and `include:amazonses.com`). Two records are an SPF permerror, so
receivers treat all mail from the domain as unauthenticated. No DKIM key exists at the default
`google._domainkey` selector. That DNS is at the registrar, not in Cloud DNS
(`packages/infrastructure/src/infrastructure/dns.ts:191` is inert).

## Approach

`cycsail.team` becomes one Authentik-gated site for staff, volunteers, and families. Authentik
serves at `login.cycsail.team`. oauth2-proxy is retired. `directus.cycsail.team` is unchanged.

### Gating and the portal

Caddy's `cycsail.team` block does four things in order:

1. It strips any client-sent `X-Authentik-*` header.
2. It routes `/outpost.goauthentik.io/*` to Authentik.
3. It runs `forward_auth` against Authentik's embedded outpost, which admits any signed-in user.
4. It serves the portal through Caddy's `templates` handler, for `*.html` files only.

Each section in the page is wrapped in a template condition on the `X-Authentik-Groups` header:

- **Everyone** — the public links, for every signed-in user. Anyone who can prove an email can
  sign in, so these links must hold nothing sensitive.
- **Staff, Volunteers, Instructors** — for the `staff` group, mirrored from `all@`. This matches
  today, where every `all@` member sees every section.
- **Roster** — for the `families` group.
- **Help** — for anyone in neither group. It says to use the email the family registered with in
  Clubspot, or to write to `info@cyccommunitysailing.org`.

Links for other audiences never leave the server. This settles #98 without an app backend.
`packages/portal` emits the template. Its tests check the rendered conditions, as
`packages/portal/test/render.test.ts` does today.

The roster section is plain ESM from `tsc`, with no bundler. It calls `directus.cycsail.team` with
`credentials: "include"`, and no token reaches JavaScript. The two hosts are the same site, so
Directus's host-only `Lax` session cookie goes with each request. Directus needs
`CORS_ORIGIN=https://cycsail.team`, `CORS_CREDENTIALS=true`, and the portal URL in
`AUTH_AUTHENTIK_REDIRECT_ALLOW_LIST`. The page filters by team and school in pure, tested
functions. School grouping uses `normalizeName` (`packages/clubspot-sync/src/people.ts:12`).

### `community-sync`

`packages/community-sync` is a new Cloud Run job with gsuite-sync's plan-and-execute shape. It
depends on `commodore`, `directus`, `gsuite`, `crm`, and `clubspot`. It does not invert the graph.
It has three passes:

- **Login email.** It writes `people.login_email` for every person. The value is `people.email`,
  trimmed and lowercased with `normalizeEmail`, or null when `isValidEmail` fails. Both now live in
  `crm` (`packages/crm/src/email.ts`). This column is the one login-to-people mapping kept, and only
  for case. A shared email needs no mapping, because `_eq` matches every row that carries it.
- **Staff group.** It mirrors `all@` into the Authentik group `staff`. It uses `DirectoryClient`,
  with `listMembers` extended to pass `includeDerivedMembership`
  (`packages/gsuite/src/directory.ts:130`). Authentik has no inbound Google Workspace source. Its
  Google Workspace provider pushes the other way.
- **Family group.** It adds every distinct `login_email` of a current participant or their
  guardian to the Authentik group `families`. A current participant is the `participant_id.person_id`
  of a confirmed `registration_entries` row in an Active camp. A config flag keeps this pass off
  until launch.

The group passes create any missing Authentik user, keyed by lowercased email, before they set
membership. A person's group is then in place at their first sign-in. Both group passes add and
remove members. Unlike gsuite-sync (`packages/gsuite-sync/src/membership.ts:132-135`), they are
not add-only, because a stale member keeps access.

Each execution writes one `sync_runs` row, with `source: "community-sync"` and each pass's counts.
`startSyncRun` and `finishSyncRun` move from `packages/clubspot-sync/src/sync-run.ts:1118-1150`
into `directus`, which owns the collection, so both jobs share them.

`community-sync`'s `schema.yaml` declares `login_email` as an extension field on `people`.

### Directus schema

- `crm`: `people.share_contact`. Done. `share_contact_updated_at` was added and is dropped in step 13.
- `clubspot`: `programs.classes`, `classes.registration_entries`, and
  `registrations.registration_entries`. Done.
- `clubspot`: one more o2m alias, `participants.registrations`, reversing
  `registrations.participant_id`. `clubspot` owns both collections. `participant_id` is unique, so
  the alias holds at most one row.

### Directus rules

`$ME` stands for `{ "login_email": { "_eq": "$CURRENT_USER.email" } }`. Authentik's scope mapping
for Directus lowercases the `email` claim, so both sides of the comparison are normalized.

- **Acts for (`A`).** `{ "_or": [ $ME, { "my_contacts": { "relationship_type": { "_eq": "guardian" }, "contact_id": $ME } } ] }`
- **Team entry (`E`).** Applied to a `registration_entries` row. All of these hold:
  - `status` is `confirmed`.
  - `class_id.camp_id` is Active.
  - `class_id.program_id.classes` has a class in an Active camp with a confirmed
    `registration_entries.registration_id.participant_id.person_id` matching `A`.
- **Teammate (`T`).** Applied to a person: `participant_links.registrations.registration_entries`
  has an entry matching `E`.
- **Active camp.** `{ "start_date": { "_lte": "$NOW" }, "end_date": { "_gte": "$NOW" } }`. Every
  camp running today counts, so a roster is empty between seasons. There is no "next season" rule.
- **Adult.** `{ "date_of_birth": { "_lte": "$NOW(-18 years)" } }`. A null date of birth fails
  `_lte`, so it counts as a minor with no special case.

One new role, **Community** (`appAccess: false`), is the default role for the `authentik`
provider, with public registration on. Every rule depends on `$CURRENT_USER.email`, so an unmatched
user reads nothing. The role has three policies, because `DirectusPermissionRule` allows one row per
(policy, collection, action) (`packages/infrastructure/src/directus/client.ts:194-213`):

| Policy     | `people` action | Fields                                                                     | Filter                                                                                                              |
| ---------- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `names`    | read            | `id, first_name, last_name, school`                                        | `T`                                                                                                                 |
| `contacts` | read            | `id, first_name, last_name, email, phone`                                  | `contact_for` has a guardian row whose `subject_id` is a `T` with `share_contact` true, **or** `T`, Adult, opted in |
| `family`   | read, update    | read: `id, first_name, last_name, share_contact` — update: `share_contact` | `my_contacts` has a guardian matching `$ME`, **or** `$ME` and Adult                                                 |

- The `names` policy also gets id-only reads, so the page can place each teammate on a team:
  - `registration_entries` (`id`, `status`, `class_id`, `registration_id`), filtered by `E`
  - `registrations` (`id`, `participant_id`), where `registration_entries` has an `E`
  - `participants` (`id`, `person_id`), where `registrations.registration_entries` has an `E`
  - `classes`, `programs`, and `camps`, limited to ids, names, and dates
- A minor's email and phone are reachable only through `contacts`. `contacts` admits a minor only
  as a guardian's child, and there it returns the guardian's row, not the minor's.
- Directus 11+ returns a policy's fields only for items that match that policy's filter. The
  `names`/`contacts` split depends on this, and the integration test checks it.
- There are no rules on `medical_profiles`, `contacts`, or `contact_points`. No field of
  `participants` or `registrations` beyond the ids above is readable. `participants` holds guardian
  and medical answers.
- The filters are deep. `T` is up to 12 relations and `contacts` up to 14. Directus's
  `MAX_RELATIONAL_DEPTH` defaults to 10. If the integration test shows that the limit applies to
  permission filters, set it in both `packages/substrate/deploy/docker-compose.yml` and
  `dev/directus-local/docker-compose.yml`.

Two new pieces of infrastructure code:

- `DirectusPolicy`, a resource for an extra policy attached to a role.

The Guardian role stays unused.

**Directus staff move to the `authentik` provider.** Directus usernames are unique emails. A
staff member who is also a parent would collide with the Community user that the `authentik`
provider tries to create, and the Directus login would fail. The move is one change to
`ungoodUser` (`directus-roles.ts:64-70`). `google` stays enabled until that login is verified.
The bootstrap admin password is the break-glass path.

### Opt-in: the one CRM field rule

`share_contact` is on the person's `people` row. It follows #137's one rule, like every other
curated field: the latest edit always wins, whether made in the portal or in Clubspot.

- **Portal.** One family toggle updates every person the viewer is a guardian of. An adult
  participant can also update their own row.
- **Clubspot, from Spring.** `share_contact` becomes a promoted field, synced by
  `planPromotedFieldSync` (`packages/clubspot-sync/src/promoted-fields.ts:173`) with no mode of its
  own. Three changes let a boolean target through:
  - `PROMOTABLE_PERSON_FIELDS` (`packages/clubspot/src/promoted-fields.ts:7`) and the plan's
    string patch type accept it.
  - `SyncedFieldValue` (`packages/clubspot-sync/src/synced-fields.ts:12`) gains `boolean`.
  - Yes and No are parsed explicitly. Any other answer is counted and logged, and is not written.

  **#171 must land first.** Today the sync ignores a repeated or first-ever form answer made after a
  portal change. For consent, a family's newer No must win.

- **Merge.** A duplicate's `share_contact` is lost today, because `PERSON_SCALAR_FIELDS`
  (`packages/clubspot-sync/src/merge.ts:49`) does not list it. It is added there.
- **Drop `share_contact_updated_at`.** Directus revisions record when the toggle changed. The
  column is deployed but empty, and `DirectusPermissionRule` needs no `presets` support.
- Person-sync leaves `share_contact` alone (`packages/clubspot-sync/src/people.ts:497`).

### Authentik deployment

- **Containers.** `authentik-server` and `authentik-worker`, with a Caddy block for `login.`. Pin
  a release that needs no Redis.
- **Database.** `postgres.database("authentik")` and a user
  (`packages/infrastructure/src/infrastructure/database.ts:122-141`). `db-g1-small` allows about
  50 connections. Cap Authentik's workers and connection age so that it and Directus fit.
- **Memory.** The VM is `e2-medium` with 4 GB (`compute.ts:11`). Authentik wants about 2 GB. The
  implementer measures `docker stats` and **stops to report the numbers before adding Authentik**.
  The user then compares a resize with other hosting options, such as GKE Autopilot.
- **Secrets.** Pulumi's `randomSecret` in `infrastructure` makes the bootstrap token, the secret
  key, the DB password, and the Directus OIDC client secret. They are granted to `substrate-runner`.
- **Config.** A new Pulumi project, `packages/infrastructure/src/authentik`, applied after
  `infrastructure`. It uses the goauthentik Terraform provider through
  `pulumi package add terraform-provider`, wrapped in classes with secure defaults. It declares:
  - the Google source, with email matching
  - the email-code flow and SMTP
  - the proxy application for `cycsail.team`
  - the Directus OIDC application and its lowercasing scope mapping
  - the `staff` and `families` groups
  - "users cannot change their own email"
  - the sync's service account, whose RBAC role covers creating users and managing those two
    groups only

  It reads the Directus client secret by name, as `crm/index.ts:37-41` reads the admin password.

- **IAM.** The job's service account goes in `packages/infrastructure/src/bootstrap`, like
  `gsuite-sync.ts`. Its grants go in `config.ts`. It needs domain-wide delegation for
  `admin.directory.group.member.readonly`, which is a manual Workspace step. Its Directus machine
  user gets:
  - read on `people` (`id`, `email`) and update on `people` (`login_email`) only
  - read on `participants` (`id`, `person_id`) only, as gsuite-sync has (`crm/index.ts:263-267`)
  - read on `contacts`, `registrations`, `registration_entries`, `classes`, and `camps`
  - create and update on `sync_runs`
- **Retire oauth2-proxy.** Remove its container, `portalOauthCookieSecret` (`portal.ts:220-224`),
  and `substrateSelfSign` (`substrate.ts:32-36`). `substrateSelfSign` exists only for oauth2-proxy's
  delegation. Revoke the substrate account's delegation in Workspace.

### Email

Authentik sends as `noreply@cyccommunitysailing.org` through the Workspace SMTP relay. The relay
authenticates the VM's static IP (`compute.ts:24`). SPF, DKIM (selector `dkim`), and DMARC are already in place. The relay needs a
rule that accepts mail only from that IP and only for addresses in the domain.

### Integration test

The Community rules are defined once, as plain data in `packages/infrastructure/src/crm/`. Pulumi
creates them from that data, and the integration test applies the same data, so the test checks
the rules that ship.

The test runs in CI on every pull request. It starts `dev/directus-local` with
`DIRECTUS_LICENSE_KEY` from a GitHub Actions secret, because Directus enforces relational rules only
with a license (`packages/infrastructure/src/infrastructure/directus.ts:41`). A missing key fails
the job; it never skips. The test applies the merged schema and the Community rules, then seeds the
fixtures below as local password users. No Authentik is needed, because every rule keys on
`$CURRENT_USER.email`.

Fixtures, in test programs P and Q. One class in P belongs to an ended camp. Every participant is
seeded as a `people` row, a `participants` row with a string id, and a `registrations` row whose
`participant_id` points at it. Clubspot collections take string ids, as the sync enters them.
`login_email` is seeded as community-sync would write it.

| Login            | Setup                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `a@` (lowercase) | Guardian of minor A1 in P, opted in. A1 shares `a@`.                                  |
| `b@`             | Stored as `B@` in `people.email`. Guardian of minor B1 in P. `share_contact` is null. |
| `c@`             | Adult participant in P, opted in.                                                     |
| `d@`             | Participant in P with no date of birth, opted in.                                     |
| `e@`             | Guardian of E1 in Q, opted in.                                                        |
| `i@`             | Guardian of I1, who is only in P's ended-camp class, opted in.                        |
| `x@`             | No match.                                                                             |

Assertions, through the REST API as each login:

- `a@` reads names A1, B1, C, D. It reads no E1 and no I1.
- `a@` reads email and phone for A and C only. It reads no email or phone for A1, B, B1, or D.
  This is the check that Directus scopes each policy's fields to that policy's rows.
- `b@` sees the same names, and contact for A and C. This proves the case normalization.
- `e@` reads E1 only. `i@` reads nothing in P.
- `x@` gets an empty list from `/items/people`.
- `a@` PATCHes A1 `share_contact` to false, and `b@` loses A's contact on its next read.
- `a@` cannot PATCH B1, or A1's `email`. `d@` cannot PATCH anything. `c@` can PATCH its own
  `share_contact`.
- `a@` reads the ids that join B1 to P's class, and no other field of B1's `participants` or
  `registrations` row.
- Every fixture login gets 403 or an empty list from `medical_profiles`, `contacts`, and
  `contact_points`.

After deploy, a smoke check in production confirms staff sign-in, staff sections, and one test
family's roster, and records the roster query's response time.

### Launch prerequisite

The board must approve sharing names and contact information before the `families` pass is turned
on. Everything else ships and is verified with test accounts before that approval.

### Future work

- Finer staff sections, and roles from #156, replacing the `all@` mirror.
- FreeScout through Authentik's SAML module.

## Alternatives

- **A separate host for families, with oauth2-proxy kept for staff.** The user chose one host.
- **Sync-written roster tables.** The user chose live rules. Only `login_email` is
  sync-written, for the reason above.
- **A Postgres generated column for `login_email`.** It is not clear that Directus's schema apply
  creates generated columns.
- **Directus staff stay on `google`.** Rejected, because of the unique email collision.
- **Per-audience static pages, or client-side filtering.** Pages multiply with each group
  combination. Client-side filtering leaves every link in the page source.
- **Authentik blueprints.** Removing an entry does not delete the object, and there is no preview.
- **A newest-wins mode just for `share_contact`.** It would be a second sync rule beside #137's.
- **Match sign-ins on any known email in `contact_points`.** An address a family stopped using
  would keep granting access. The user chose the primary email only.

## Steps

1. Done. `crm`: add `share_contact` and `share_contact_updated_at`, and move `normalizeEmail` and
   `isValidEmail` from gsuite-sync.
2. Done. `clubspot`: add the three o2m aliases.
3. Done. Measure VM memory, and report the numbers to the user.
4. Done. Set up the Workspace SMTP relay rule, and record it in `docs/manual-setup.md`.
5. Done. Infrastructure: the Authentik database, secrets, containers, and the `login.` record and
   Caddy block. `substrate-apply.ts` reconciles the running VM when the compose file or the image
   changes.
6. `clubspot`: add the `participants.registrations` alias. Schema change, serialized.
7. The `authentik` Pulumi project, added to `just deploy`.
8. `directus`: move `startSyncRun` and `finishSyncRun` from clubspot-sync.
9. `community-sync`: the schema (`login_email`), the plan functions with tests, the executor, the
   job, its `sync_runs` row, the identity, delegation, and the Directus machine user. The family
   pass stays off.
10. Portal and substrate: the templated portal on a temporary `preview.cycsail.team`, gated by
    Authentik. Staff confirm sign-in and the staff sections.
11. Cutover: point `cycsail.team` at the new block. Remove oauth2-proxy, the preview host,
    `portalOauthCookieSecret`, and `substrateSelfSign`, and revoke the old delegation. Staff confirm
    access.
12. Directus: the `authentik` provider, CORS, and `DirectusPolicy`. Then the
    Community role and its three policies, and moving `ungoodUser` to `authentik`. The rules land
    with the integration test running in CI, which needs the license key stored as a GitHub Actions
    secret. Raise `MAX_RELATIONAL_DEPTH` here if the test needs it.
13. Done. `authentik`: an enrollment flow (prompt for email, verify it, write a no-group user,
    log in), linked from the identification stage and the Google source, so an unmatched email
    lands signed in with no group instead of failing. Purpose-written email templates replace
    Authentik's password-reset wording for the sign-in and verification emails, shipped to the VM
    through the same file-shipping mechanism as the compose file, and mounted into both Authentik
    containers.
14. `clubspot-sync`: add `share_contact` to the merge's person fields, and drop
    `share_contact_updated_at` from `crm`.
15. Portal: the roster section and the toggle.
16. The production smoke check.
17. After board approval, turn on the family pass.
18. Spring, after #171: the Clubspot opt-in field, as a boolean promoted field under #137's rule.
19. Docs: READMEs, `docs/crm-schema.md`, and the `CLAUDE.md` package list, graph, and auth section.

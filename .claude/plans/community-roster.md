# Community roster on Authentik

## Context

Race team families cannot find the other people on their team (#166). The CRM already holds the
data, but no family can log in, and no permission rule lets anyone read another family's rows.

- Every request to `cycsail.team` goes through oauth2-proxy, and only `all@` members pass
  (`packages/substrate/deploy/Caddyfile:18-43`, `docker-compose.yml:38`).
- The Guardian policy lets a guardian read only their own minors (`guardianFilter`,
  `packages/infrastructure/src/crm/index.ts:93-113`). The Guardian role has no login
  (`packages/infrastructure/src/infrastructure/directus-roles.ts:42-56`).
- `people.directus_user_id` is unique (`packages/directus/schema.yaml:943`). A family commonly
  shares one email across a parent and a child, so it cannot be the login link.
- `people.email` is raw Clubspot text with mixed case. Directus `_eq` is case-sensitive on
  Postgres, and `docs/crm-schema.md` notes that the filters offer only `_eq` and `_icontains`.
  `_icontains` is a substring match, so it is not safe for identity.
- The relations a teammate rule needs have no o2m alias: `programs` → `classes`, `classes` →
  `registration_entries`, and `registrations` → `registration_entries`
  (`packages/clubspot/schema.yaml:3877`, `:3919`, `:4045`, where `one_field` is null).

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
functions. School grouping uses `normalizeName` (`packages/clubspot-sync/src/people.ts:11`).

### `community-sync`

`packages/community-sync` is a new Cloud Run job with gsuite-sync's plan-and-execute shape. It
depends on `commodore`, `directus`, `gsuite`, `crm`, and `clubspot`. It does not invert the graph.
It has three passes:

- **Login email.** It writes `people.login_email` for every person. The value is `people.email`,
  trimmed and lowercased, or null when `isValidEmail` fails. Move `normalizeEmail` and
  `isValidEmail` from `packages/gsuite-sync/src/membership.ts:34-45` into `crm`, so both syncs
  share one rule. This column is the one login-to-people mapping kept, and only for case. A shared
  email needs no mapping, because `_eq` matches every row that carries it.
- **Staff group.** It mirrors `all@` into the Authentik group `staff`. It uses `DirectoryClient`,
  with `listMembers` extended to pass `includeDerivedMembership`
  (`packages/gsuite/src/directory.ts:130`). Authentik has no inbound Google Workspace source. Its
  Google Workspace provider pushes the other way.
- **Family group.** It adds every distinct `login_email` of a current participant or their
  guardian to the Authentik group `families`. A config flag keeps this pass off until launch.

The group passes create any missing Authentik user, keyed by lowercased email, before they set
membership. A person's group is then in place at their first sign-in. Both group passes add and
remove members. Unlike gsuite-sync (`membership.ts:121-124`), they are not add-only, because a
stale member keeps access.

`community-sync`'s `schema.yaml` declares `login_email` as an extension field on `people`.

### Directus schema

- `crm`: `people.share_contact` (nullable boolean) and `people.share_contact_updated_at`
  (timestamp). Null means never answered, and it is treated as not shared.
- `clubspot`: the o2m aliases `programs.classes`, `classes.registration_entries`, and
  `registrations.registration_entries`. `clubspot` owns these relations. `programs.classes` is an
  extension field on a `crm` collection, like `programs.google_group_id`.

### Directus rules

`$ME` stands for `{ "login_email": { "_eq": "$CURRENT_USER.email" } }`. Authentik's scope mapping
for Directus lowercases the `email` claim, so both sides of the comparison are normalized.

- **Acts for (`A`).** `{ "_or": [ $ME, { "my_contacts": { "relationship_type": { "_eq": "guardian" }, "contact_id": $ME } } ] }`
- **Teammate (`T`).** Applied to a person:
  `registration_links.registration_entries` has an entry where all of these hold:
  - `status` is `confirmed`.
  - `class_id.camp_id` is Active.
  - `class_id.program_id.classes` has a class in an Active camp with a confirmed
    `registration_entries.registration_id.person_id` matching `A`.
- **Active camp.** `{ "start_date": { "_lte": "$NOW" }, "end_date": { "_gte": "$NOW" } }`. Every
  camp running today counts, so a roster is empty between seasons. There is no "next season" rule.
- **Adult.** `{ "date_of_birth": { "_lte": "$NOW(-18 years)" } }`. A null date of birth fails
  `_lte`, so it counts as a minor with no special case.

One new role, **Community** (`appAccess: false`), is the default role for the `authentik`
provider, with public registration on. Every rule depends on `$CURRENT_USER.email`, so an unmatched
user reads nothing. The role has three policies, because `DirectusPermissionRule` allows one row per
(policy, collection, action) (`packages/infrastructure/src/directus/client.ts:199-213`):

| Policy     | `people` action | Fields                                                                     | Filter                                                                                 |
| ---------- | --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `names`    | read            | `id, first_name, last_name, school`                                        | `T`                                                                                    |
| `contacts` | read            | `id, first_name, last_name, email, phone`                                  | a guardian of a `T` with `share_contact` true, **or** a `T` that is Adult and opted in |
| `family`   | read, update    | read: `id, first_name, last_name, share_contact` — update: `share_contact` | `my_contacts` has a guardian matching `$ME`, **or** `$ME` and Adult                    |

- The `family` update rule presets `share_contact_updated_at` to `$NOW`. The client can never set
  it.
- The `names` policy also gets read rules on `registration_entries`, `classes`, and `programs`,
  limited to ids and names, so the page can show teams.
- A minor's email and phone are reachable only through `contacts`. `contacts` admits a minor only
  as a guardian's child, and there it returns the guardian's row, not the minor's.
- Directus 11+ returns a policy's fields only for items that match that policy's filter. The
  `names`/`contacts` split depends on this, and the verification below checks it.
- There are no rules on `medical_profiles`, `contacts`, or `registrations` rows themselves.

Two new pieces of infrastructure code:

- `DirectusPolicy`, a resource for an extra policy attached to a role.
- `presets` support on `DirectusPermissionRule`.

The Guardian role stays unused.

**Directus staff move to the `authentik` provider.** Directus usernames are unique emails. A
staff member who is also a parent would collide with the Community user that the `authentik`
provider tries to create, and the Directus login would fail. The move is one change to
`ungoodUser` (`directus-roles.ts:62-68`). `google` stays enabled until that login is verified.
The bootstrap admin password is the break-glass path.

### Opt-in: newest answer wins

`share_contact` sits on the participant row. `promoted_fields` writes the registration's person,
so the Clubspot answer lands there.

- **Portal.** One family toggle updates every participant the viewer is a guardian of. An adult
  participant can also update their own row. The preset stamps `share_contact_updated_at`.
- **Clubspot, from Spring.** The time of an answer is its registration's `registered_at`.
  `custom_field_responses` has no timestamp of its own. `planPromotedFields` gets a newest-wins
  mode for this one target. It writes `share_contact`, and it writes `registered_at` into
  `share_contact_updated_at`, when the winning response is newer than the stored timestamp or the
  stored timestamp is null. It parses Yes and No explicitly, and it counts and logs any other
  answer. `PROMOTABLE_PERSON_FIELDS` (`packages/clubspot/src/promoted-fields.ts:7`) allows text
  only today.
- An answer edited in Clubspot after registration keeps the old `registered_at`, so the sync
  ignores the edit.

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
  - read on `contacts`, `registrations`, `registration_entries`, `classes`, `camps`, and `programs`
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

Fixtures, in test programs P and Q. One class in P belongs to an ended camp.

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
  `share_contact_updated_at` holds server time, even when the payload sends another value.
- `a@` cannot PATCH B1, or A1's `email`. `d@` cannot PATCH anything. `c@` can PATCH its own
  `share_contact`.
- Every fixture login gets 403 or an empty list from `medical_profiles`, `contacts`, and
  `registrations`.

After deploy, a smoke check in production confirms staff sign-in, staff sections, and one test
family's roster, and records the roster query's response time. The teammate filter is about ten
relations deep.

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

## Steps

1. `crm`: add `share_contact` and `share_contact_updated_at`, and move `normalizeEmail` and
   `isValidEmail` from gsuite-sync. Schema change, serialized.
2. `clubspot`: add the three o2m aliases. Serialized.
3. Measure VM memory. **Stop and report the numbers to the user.**
4. Set up the Workspace SMTP relay rule, and record it in `docs/manual-setup.md`.
5. #107's first half: a re-runnable substrate apply, so compose and Caddy changes reach the
   running VM without replacing it. Steps 6, 9, 10, and 11 rely on it.
6. Infrastructure: the Authentik database, secrets, containers, and the `login.` record and Caddy
   block. `cycsail.team` does not change yet.
7. The `authentik` Pulumi project, added to `just deploy`.
8. `community-sync`: the schema (`login_email`), the plan functions with tests,
   the executor, the job, the identity, delegation, and the Directus machine user. The family pass
   stays off.
9. Portal and substrate: the templated portal on a temporary `preview.cycsail.team`, gated by
   Authentik. Staff confirm sign-in and the staff sections.
10. Cutover: point `cycsail.team` at the new block. Remove oauth2-proxy, the preview host,
    `portalOauthCookieSecret`, and `substrateSelfSign`, and revoke the old delegation. Staff confirm
    access.
11. Directus: the `authentik` provider, CORS, and `DirectusPolicy` with `presets`. Then the
    Community role and its three policies, and moving `ungoodUser` to `authentik`. The rules land with the integration test
    running in CI, which needs the license key stored as a GitHub Actions secret.
12. Portal: the roster section and the toggle.
13. The production smoke check.
14. After board approval, turn on the family pass.
15. Spring: the Clubspot opt-in field, with newest wins in `planPromotedFields`.
16. Docs: READMEs, `docs/crm-schema.md`, and the `CLAUDE.md` package list, graph, and auth section.

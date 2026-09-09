# Manual setup steps

Most of this platform is infrastructure-as-code (Pulumi, in `packages/infrastructure`). A handful of
steps **cannot** be — they live in Google consoles, the Workspace Admin console, or the domain
registrar, or they involve secret _values_ that must never enter git. This doc is the running record
of every such out-of-band step, so setting up a fresh environment (or recovering one) doesn't rely
on memory.

Legend: `[ ]` = to do for a new setup, `[x]` = done for the current production setup (as of this doc).

> Why these can't be code: OAuth "Web application" clients and the **External** consent screen have
> no Terraform/Pulumi resource; domain-wide delegation and Workspace settings live in the Admin
> console and would require super-admin credentials that our access policy deliberately keeps out of
> automation (see [CLAUDE.md](../CLAUDE.md) → Access policy); registrar delegation is at the domain
> registrar; and external credentials (OAuth secrets, third-party logins) are set out of band by
> design — Pulumi declares only the container for those. Internal keys/passwords with no meaningful
> human choice are the exception: Pulumi generates and manages those values directly (see §3).

---

## 1. Project & organization bootstrap (super-admin)

Done as a Workspace **super-admin** (`master@cyccommunitysailing.org`). Reserved to super-admins per
the access policy — not day-to-day deploy identities.

- [x] GCP project `cyc-admin-scripts` created under the org.
- [x] Org policy / project-root IAM as needed.
- [ ] Any Google API that must be enabled by hand (most are enabled in code via the `enableService`
      helper; enable by hand only if a chicken-and-egg case appears).

## 2. Per-person deploy/dev access

Each contributor authenticates locally; nothing is stored in the repo. See
[README.md → Authentication](../README.md#authentication).

- [ ] `just auth-gcp` — `gcloud auth login` as your own account (e.g. `ungood@onetrue.name`), which is
      granted deploy + impersonation rights in `packages/infrastructure/src/config.ts`.
- [ ] `just auth-adc` — ADC impersonating `report-runner@…` for running tools locally.
- Do **not** log in as a super-admin for development.

## 3. Secret values (Secret Manager)

Most secrets here are **external credentials** — Pulumi declares only the container, and the value
is added out of band and never committed:

```sh
printf %s 'THE_VALUE' | gcloud secrets versions add SECRET_ID --data-file=- --project cyc-admin-scripts
```

A few (marked below) are **internal keys/passwords with no meaningful human choice** — Pulumi
generates and manages those values itself (`randomSecret` in `secret.ts`); nothing to do for them
here, they're listed for completeness.

| Secret ID                           | Used by                          | Source of the value                                                                                                                  |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `clubspot-username`                 | run-reports job                  | TheClubSpot login email                                                                                                              |
| `clubspot-password`                 | run-reports job                  | TheClubSpot login password                                                                                                           |
| `google-oauth-client-id`            | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1 — one sign-in for both surfaces                                                                        |
| `google-oauth-client-secret`        | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1                                                                                                        |
| `directus-license-key`              | Directus                         | The Open Innovation Grant (or paid) license key — see §6 intro. Optional at the Pulumi level; required for the Guardian role to work |
| `portal-oauth-cookie-secret`        | portal oauth2-proxy              | **Pulumi-generated.** URL-safe base64, 32 bytes.                                                                                     |
| `directus-key`                      | Directus                         | **Pulumi-generated.** 32 random bytes, hex.                                                                                          |
| `directus-secret`                   | Directus                         | **Pulumi-generated.** 32 random bytes, hex.                                                                                          |
| `directus-db-password`              | Directus                         | **Pulumi-generated** and set directly on the `directus` Postgres role too (§6.1) — one value, no copying by hand                     |
| `directus-admin-bootstrap-password` | Directus                         | **Pulumi-generated.** Not a human-facing credential — only what the `Directus*` dynamic resources (§6.2) authenticate as             |

## 4. DNS registrar delegation

Cloud DNS managed zones are created in code (`dns.ts`) but are **inert** until each domain's
registrar delegates to the zone's name servers. Look the name servers up after an apply with
`pulumi stack output nameServers`, then set them at the registrar. For the existing external domain,
migrate its current records into the zone _before_ delegating.

- [ ] `cyccommunitysailing.org` (external / public site)
- [x] `cycsail.team` (internal / portals)
- [ ] `cycsailing.center` (link shortener)

## 5. Shared Google auth (`cycsail.team` + `crm.cycsail.team`)

**One** Google OAuth client, shared platform-wide (`substrate.ts`) — signing into one surface
signs into all of them. Needed before either the portal or the people hub actually serves.

### 5.1 OAuth 2.0 Client ID + consent screen — Google Cloud console

- [x] Consent screen **External** (so personal Google accounts — volunteers, guardians — can sign
      in).
- [x] An OAuth 2.0 Client ID, type **Web application**, exists already for the portal
      (`https://cycsail.team/oauth2/callback`).
- [ ] Add the people hub's redirect URI to that **same** client (don't create a second one):
      `https://crm.cycsail.team/auth/login/google/callback`.
- [ ] Copy that client's id/secret (unchanged) into the renamed secrets `google-oauth-client-id` /
      `google-oauth-client-secret` (§3) — replacing the old `portal-oauth-client-id`/`-secret`.

### 5.2 Domain-wide delegation — Workspace Admin console

So oauth2-proxy can read Google Group membership via the Directory API using the substrate VM's
service account (ADC — no key file).

- [x] Workspace Admin → Security → API controls → Domain-wide delegation: authorize the
      **substrate-runner** service account's client ID for scope
      `https://www.googleapis.com/auth/admin.directory.group.readonly`.
- [x] Confirm the impersonated admin (`portalAuthAdminEmail`, default `master@…`) is a Workspace admin.
- [ ] ⚠️ **Verify nested-group resolution:** confirm a member of `staff@` (nested under `all@`) is
      admitted. If oauth2-proxy only honors direct membership, list the subgroups explicitly instead.

### 5.3 Access group — Workspace Admin console

- [x] `all@cyccommunitysailing.org` exists and nests the audience subgroups (`staff@`, `volunteers@`,
      …). Ensure the intended members are in it (including a test personal Gmail).

## 6. Directus / people hub (`crm.cycsail.team`)

Backing the people hub (see [docs/people-hub-schema.md](people-hub-schema.md)). No oauth2-proxy in
front of this surface — Directus authenticates directly via its own native Google OIDC (the shared
client from §5.1) and enforces roles/permissions server-side.

> ⚠️ **License note:** the relationship-based permission filters this data model depends on (a
> guardian reading only their own minor's record, e.g. the `Guardian` role's `$CURRENT_USER`-scoped
> rules) are gated behind a Directus license on v12+ (MSCL) — confirmed hands-on while building the
> schema (a fresh, unlicensed v12.3.1 instance rejected any permission with a `permissions` filter
> with `403 custom_permission_rules_enabled is a restricted resource`).
>
> CYC has a license via Directus's [Open Innovation Grant](https://directus.com/oig) (nonprofit,
> well under the $5M revenue / 50 employee thresholds — free, explicitly includes custom access
> policies, valid one year and renewable). `docker-compose.yml` is pinned to a current `12.x` with
> `LICENSE_KEY` wired in (§3, `directus-license-key`) — set that secret before first boot, and
> renew the grant/license annually.

Everything below is now `pulumi up` — the only genuinely irreducible manual step left is the one
Postgres `GRANT` in §6.1 (it needs a live SQL connection; nothing that runs `pulumi up` has a
network path to Cloud SQL's private IP today). No more `directus schema apply` CLI, no more
first-boot-admin-then-create-my-account dance, no more secret values to invent — `directus-key`,
`directus-secret`, `directus-db-password`, `directus-admin-bootstrap-password`, and
`portal-oauth-cookie-secret` are all Pulumi-generated now (see `randomSecret` in `secret.ts`),
nothing to fill in for them in §3.

### 6.1 Database role — Cloud SQL

Pulumi creates the `directus` Postgres role itself (`postgres.user()` in `database.ts`, via the
Cloud SQL Admin API — no network path to the instance needed for that part) with the generated
`directus-db-password` value. What Pulumi **can't** do: grant that role privileges on the
`directus` database — Postgres 16's tightened default (no public `CREATE` on a fresh database's
`public` schema) means that needs a live SQL connection, and Cloud SQL here is private-IP-only with
no network path from wherever `pulumi up` runs. One remaining manual step:

- [ ] Connect to the `substrate` Cloud SQL instance (`gcloud sql connect substrate --user=postgres`,
      or via a bastion/IAP tunnel) and run:
      `sql
GRANT ALL PRIVILEGES ON SCHEMA public TO directus;
GRANT ALL PRIVILEGES ON DATABASE directus TO directus;
`
      (Deliberately not automated with an IAP-tunnel-in-a-Pulumi-resource for one `GRANT` — the
      fragility didn't seem worth it for something this narrow. Say so if that trade-off should go
      the other way.)

### 6.2 Schema, roles, and the first Staff account — all `pulumi up`

`infrastructure/src/people-hub.ts` applies the committed
[`packages/people-hub/schema.yaml`](../packages/people-hub/schema.yaml) snapshot
(`DirectusSchema`, via Directus's own `/schema/diff` + `/schema/apply` REST endpoints — going
through the running server's API instead of the CLI also means no restart-for-stale-cache gotcha),
creates the Staff/Coach/Guardian roles (`DirectusRole`), and provisions `ungood@onetrue.name` as a
Staff user via Google OIDC (`DirectusUser` — no password; signing in with that Google account just
works, no bootstrap-admin dance).

- [ ] `pulumi up`. Needs `directus-admin-bootstrap-password` to already have a value (Pulumi
      generates it — see above, nothing to do) and Directus to already be reachable at
      `https://crm.cycsail.team` — these resources retry for a few minutes if it isn't yet, but
      won't wait forever. On a truly fresh deploy this is often the _second_ `pulumi up` (first:
      secrets/DB/DNS containers + the VM; you do §6.1's `GRANT` and confirm the VM picked up the
      compose stack; second: this).
- [ ] Provisioning additional staff this way (rather than through the Directus UI) is a reasonable
      next step once there's an actual list of who needs access — add more `DirectusUser` resources
      to `people-hub.ts`.

---

## When you add a new manual step

If you introduce infrastructure that needs an out-of-band action, add it here (and cross-link from
the relevant package README), so this stays the single source of truth for "things I had to do by
hand."

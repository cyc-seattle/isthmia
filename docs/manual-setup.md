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
> registrar; and secret values are set out of band by design (Pulumi declares only the containers).

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

Pulumi declares each secret **container**; the value is added out of band and never committed. Set a
value with:

```sh
printf %s 'THE_VALUE' | gcloud secrets versions add SECRET_ID --data-file=- --project cyc-admin-scripts
```

| Secret ID                           | Used by                          | Source of the value                                                                                                                  |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `clubspot-username`                 | run-reports job                  | TheClubSpot login email                                                                                                              |
| `clubspot-password`                 | run-reports job                  | TheClubSpot login password                                                                                                           |
| `google-oauth-client-id`            | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1 — one sign-in for both surfaces                                                                        |
| `google-oauth-client-secret`        | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1                                                                                                        |
| `portal-oauth-cookie-secret`        | portal oauth2-proxy              | `openssl rand -base64 32 \| tr -- '+/' '-_'` (oauth2-proxy requires URL-safe base64; the boot script also normalizes)                |
| `directus-key`                      | Directus                         | `openssl rand -hex 32`                                                                                                               |
| `directus-secret`                   | Directus                         | `openssl rand -hex 32`                                                                                                               |
| `directus-db-password`              | Directus                         | Set when creating the `directus` Postgres role in §6.1 — pick the value first, then use it in both places                            |
| `directus-admin-bootstrap-password` | Directus                         | `openssl rand -base64 24` — first-boot superadmin only, see §6.3; also what Pulumi authenticates as to create roles                  |
| `directus-license-key`              | Directus                         | The Open Innovation Grant (or paid) license key — see §6 intro. Optional at the Pulumi level; required for the Guardian role to work |

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

### 6.1 Database role — Cloud SQL

Pulumi declares the `directus` database (`database.ts`) but not its Postgres role/password — same
"container only, value out of band" split as every other secret here.

- [ ] Connect to the `substrate` Cloud SQL instance (`gcloud sql connect substrate --user=postgres`,
      or via a bastion/IAP tunnel) and create the role Directus connects as:
      `sql
CREATE USER directus WITH PASSWORD 'the same value stored in directus-db-password (§3)';
GRANT ALL PRIVILEGES ON DATABASE directus TO directus;
`

### 6.2 Apply the schema, then let Pulumi create the roles

The committed [`packages/people-hub/schema.yaml`](../packages/people-hub/schema.yaml) snapshot
covers collections/fields/relations (including the `guardian_links` alias field the Guardian role's
filters depend on). Roles/policies/permissions are **not** in that snapshot — `directus schema
apply` doesn't touch those — they're Pulumi-managed resources instead
(`infrastructure/src/people-hub.ts`, built on the `DirectusRole` dynamic resource in `directus.ts`).

- [ ] `directus schema apply schema.yaml -y` against the running instance (e.g.
      `docker exec <container> npx directus schema apply /path/to/schema.yaml -y`, having copied the
      file in first).
- [ ] **Restart the Directus container.** Its in-memory schema cache doesn't pick up the new
      collections until it restarts — anything against the new collections beforehand (Pulumi's
      role creation included) fails with a confusing "You don't have permission to access
      collection ... or it does not exist" 403. Confirmed hands-on while writing this.
- [ ] `pulumi up`. Creates the Staff/Coach/Guardian roles from
      [docs/people-hub-schema.md](people-hub-schema.md). Needs `directus-admin-bootstrap-password`
      to already have a value (§3) and Directus to already be reachable at `https://crm.cycsail.team`
      — the resource retries for a few minutes if it isn't yet, but won't wait forever. On a truly
      fresh deploy this is often the _third_ `pulumi up` in the sequence (first: secrets/DB/DNS
      containers; you set values and do the manual steps above; second: VM picks up the compose
      stack; third: this).

### 6.3 First-boot admin, then real staff accounts

- [ ] First boot creates one superadmin from `DIRECTUS_ADMIN_EMAIL` /
      `directus-admin-bootstrap-password` (§3). Sign in once, then do §6.2.
- [ ] Provision real staff as Directus users with the **Staff** role (from §6.2), authenticating via
      the shared Google OIDC client (§5.1) — no self-registration
      (`AUTH_GOOGLE_ALLOW_PUBLIC_REGISTRATION=false`), an admin creates each user's Directus account
      first.
- [ ] Rotate `directus-admin-bootstrap-password` and stop using the bootstrap account for daily use
      once real Staff accounts exist. (It stays needed for `pulumi up` to manage the roles in §6.2 —
      rotate it in Secret Manager and Directus together, not just one side.)

---

## When you add a new manual step

If you introduce infrastructure that needs an out-of-band action, add it here (and cross-link from
the relevant package README), so this stays the single source of truth for "things I had to do by
hand."

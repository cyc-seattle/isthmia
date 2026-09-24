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

- [ ] `just auth-gcp` — `gcloud auth login` as your own account, which needs project `roles/owner`
      on `cyc-admin-scripts` (§7) for `pulumi up` to work.
- [ ] `just auth-adc` — ADC as your own account, for `pulumi`/`docker` and for running tools locally.
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

| Secret ID                           | Used by                          | Source of the value                                                                                                                      |
| ----------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `clubspot-username`                 | run-reports job                  | TheClubSpot login email                                                                                                                  |
| `clubspot-password`                 | run-reports job                  | TheClubSpot login password                                                                                                               |
| `google-oauth-client-id`            | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1 — one sign-in for both surfaces                                                                            |
| `google-oauth-client-secret`        | oauth2-proxy (portal) + Directus | Shared OAuth client from §5.1                                                                                                            |
| `directus-license-key`              | Directus                         | The Open Innovation Grant (or paid) license key — see §6 intro. Optional at the Pulumi level; required for the Guardian role to work     |
| `portal-oauth-cookie-secret`        | portal oauth2-proxy              | **Pulumi-generated.** URL-safe base64, 32 bytes.                                                                                         |
| `directus-key`                      | Directus                         | **Pulumi-generated.** 32 random bytes, hex.                                                                                              |
| `directus-secret`                   | Directus                         | **Pulumi-generated.** 32 random bytes, hex.                                                                                              |
| `directus-db-password`              | Directus                         | **Pulumi-generated** and set directly on the `directus` Postgres role too, via the `postgresql` provider — one value, no copying by hand |
| `directus-admin-bootstrap-password` | Directus                         | **Pulumi-generated.** Not a human-facing credential — only what the `Directus*` dynamic resources authenticate as                        |

## 4. DNS registrar delegation

Cloud DNS managed zones are created in code (`dns.ts`) but are **inert** until each domain's
registrar delegates to the zone's name servers. Look the name servers up after an apply with
`pulumi stack output nameServers`, then set them at the registrar. For the existing external domain,
migrate its current records into the zone _before_ delegating.

- [ ] `cyccommunitysailing.org` (external / public site)
- [x] `cycsail.team` (internal / portals)
- [ ] `cycsailing.center` (link shortener)

## 5. Shared Google auth (`cycsail.team` + `directus.cycsail.team`)

**One** Google OAuth client, shared platform-wide (`substrate.ts`) — signing into one surface
signs into all of them. Needed before either the portal or the CRM actually serves.

### 5.1 OAuth 2.0 Client ID + consent screen — Google Cloud console

- [x] Consent screen **External** (so personal Google accounts — volunteers, guardians — can sign
      in).
- [x] An OAuth 2.0 Client ID, type **Web application**, exists already for the portal
      (`https://cycsail.team/oauth2/callback`).
- [ ] Add the CRM's redirect URI to that **same** client (don't create a second one):
      `https://directus.cycsail.team/auth/login/google/callback`.
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

### 5.4 Groups Administrator role — Workspace Admin console

An **alternative** to domain-wide delegation (§5.2), not an addition to it — `gsuite-sync` writes
group membership and settings as itself, so it holds the Groups Administrator role directly rather
than impersonating an admin.

- [ ] Sign in as a Workspace super-admin (`master@cyccommunitysailing.org`).
- [ ] Admin console → Account → Admin roles → **Groups Admin** → Assign service accounts → add
      `gsuite-sync@cyc-admin-scripts.iam.gserviceaccount.com`.
- [ ] Before the first real run, confirm with `gsuite-sync --dry-run` against one throwaway group
      that the Groups Settings API also accepts this credential — Google's announcement of
      role-assignable service accounts covers the Directory API and says nothing about Groups
      Settings. If it 403s, drop the settings pass rather than adding delegation for it.

## 6. Directus / CRM (`directus.cycsail.team`)

Backing the CRM (see [docs/crm-schema.md](crm-schema.md)). No oauth2-proxy in
front of this surface — Directus authenticates directly via its own native Google OIDC (the shared
client from §5.1) and enforces roles/permissions server-side.

- [ ] Create a `promoted_fields` row with `target_field: school` and the Clubspot labels to match
      (see [packages/clubspot-sync/README.md](../packages/clubspot-sync/README.md)).
- [ ] **Settings → AI → Model Context Protocol:** toggle **MCP Server** on, and set client
      registration to **Client ID Metadata Document**. `MCP_ENABLED` defaults to on but only
      exposes this toggle; the server stays off until someone flips it. The matching
      `MCP_OAUTH_ENABLED` / `MCP_OAUTH_CIMD_ENABLED` are in `docker-compose.yml` (#152).

      Connect a client with `claude mcp add --transport http directus
      https://directus.cycsail.team/mcp`, then authorize in the browser. MCP acts as the signed-in
      user under their own policy, so Staff/Coach/Guardian governs it and there is no separate
      grant to maintain.

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

## 7. Deployer identity and access (bootstrap)

Done as a Workspace **super-admin**, granting a human, not code, since these are IAM-policy grants
on the org's and project's break-glass access.

- [ ] `roles/resourcemanager.organizationAdmin` on the org, so the deployer can manage IAM without
      super-admin credentials.
- [ ] `roles/owner` on project `cyc-admin-scripts`, so `pulumi up` (including bootstrap) works.
- [ ] `roles/compute.osLoginExternalUser` on the org, for IAP SSH (`just ssh`, `just logs`,
      `just db-tunnel`) — required because Owner doesn't cover OS Login for an external principal.

```sh
gcloud organizations add-iam-policy-binding <ORG_ID> --member="user:<deployer-email>" --role="roles/resourcemanager.organizationAdmin" --condition=None
gcloud organizations add-iam-policy-binding <ORG_ID> --member="user:<deployer-email>" --role="roles/compute.osLoginExternalUser" --condition=None
```

Google refuses `roles/owner` for an external principal over the API. Grant it in the
[IAM console](https://console.cloud.google.com/iam-admin/iam?project=cyc-admin-scripts) instead:
add the principal, role **Basic → Owner**, then have them accept the emailed invitation.

## When you add a new manual step

If you introduce infrastructure that needs an out-of-band action, add it here (and cross-link from
the relevant package README), so this stays the single source of truth for "things I had to do by
hand."

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

| Secret ID                    | Used by             | Source of the value        |
| ---------------------------- | ------------------- | -------------------------- |
| `clubspot-username`          | run-reports job     | TheClubSpot login email    |
| `clubspot-password`          | run-reports job     | TheClubSpot login password |
| `portal-oauth-client-id`     | portal oauth2-proxy | OAuth client from §5.1     |
| `portal-oauth-client-secret` | portal oauth2-proxy | OAuth client from §5.1     |
| `portal-oauth-cookie-secret` | portal oauth2-proxy | `openssl rand -base64 32`  |

## 4. DNS registrar delegation

Cloud DNS managed zones are created in code (`dns.ts`) but are **inert** until each domain's
registrar delegates to the zone's name servers. Look the name servers up after an apply with
`pulumi stack output nameServers`, then set them at the registrar. For the existing external domain,
migrate its current records into the zone _before_ delegating.

- [ ] `cyccommunitysailing.org` (external / public site)
- [x] `cycsail.team` (internal / portals)
- [ ] `cycsailing.center` (link shortener)

## 5. Portal Google auth (`cycsail.team`)

Backing the [portal](../packages/portal/README.md). Needed before the site actually serves.

### 5.1 OAuth 2.0 Client ID + consent screen — Google Cloud console

- [ ] Consent screen **External** (so personal Google accounts — volunteers — can sign in).
- [ ] Create an OAuth 2.0 Client ID, type **Web application**, authorized redirect URI
      `https://cycsail.team/oauth2/callback`.
- [ ] Put the client id/secret into `portal-oauth-client-id` / `portal-oauth-client-secret` (§3).

### 5.2 Domain-wide delegation — Workspace Admin console

So oauth2-proxy can read Google Group membership via the Directory API using the substrate VM's
service account (ADC — no key file).

- [ ] Workspace Admin → Security → API controls → Domain-wide delegation: authorize the
      **substrate-runner** service account's client ID for scope
      `https://www.googleapis.com/auth/admin.directory.group.readonly`.
- [ ] Confirm the impersonated admin (`portalAuthAdminEmail`, default `master@…`) is a Workspace admin.
- [ ] ⚠️ **Verify nested-group resolution:** confirm a member of `staff@` (nested under `all@`) is
      admitted. If oauth2-proxy only honors direct membership, list the subgroups explicitly instead.

### 5.3 Access group — Workspace Admin console

- [x] `all@cyccommunitysailing.org` exists and nests the audience subgroups (`staff@`, `volunteers@`,
      …). Ensure the intended members are in it (including a test personal Gmail).

---

## When you add a new manual step

If you introduce infrastructure that needs an out-of-band action, add it here (and cross-link from
the relevant package README), so this stays the single source of truth for "things I had to do by
hand."

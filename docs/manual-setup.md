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
> automation (see [AGENTS.md](../AGENTS.md) → Access policy); registrar delegation is at the domain
> registrar; and external credentials (OAuth secrets, third-party logins) are set out of band by
> design — Pulumi declares only the container for those. Internal keys/passwords with no meaningful
> human choice are the exception: Pulumi generates and manages those values directly (see §3).

---

## 1. Project and organization (super-admin)

Moved to [platform's manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md), with the `bootstrap` stack.

## 2. Per-person deploy/dev access

Each contributor authenticates locally; nothing is stored in the repo. See
[README.md → Authentication](../README.md#authentication).

- [ ] `mise run auth-gcp` — `gcloud auth login` as your own account, which needs project `roles/owner`
      on `cyc-admin-scripts` (§7) for `pulumi up` to work.
- [ ] `mise run auth-adc` — ADC as your own account, for `pulumi`/`docker` and for running tools locally.
- Do **not** log in as a super-admin for development.

## 3. Secret values (Secret Manager)

Pods read their secrets from Kubernetes Secrets that the deploy writes. Secret Manager holds the
**external credentials**, which are set by hand: Pulumi declares only the container, and the value
is added out of band and never committed:

```sh
printf %s 'THE_VALUE' | gcloud secrets versions add SECRET_ID --data-file=- --project cyc-admin-scripts
```

The rest (marked below) are **internal keys/passwords with no meaningful human choice** — Pulumi
generates and manages those values itself, as `random` resources; nothing to do for them here.
Prod's also keep the Secret Manager copies they had on the VM (`randomSecret` in `secret.ts`), so
they're listed for completeness.

| Secret ID                      | Used by   | Source of the value                                                                                |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------- |
| `google-oauth-client-id`       | Authentik | OAuth client from §5.1, read by Authentik's Google source (§8)                                     |
| `google-oauth-client-secret`   | Authentik | OAuth client from §5.1                                                                             |
| `authentik-secret-key`         | Authentik | **Pulumi-generated.** 32 random bytes, hex.                                                        |
| `authentik-db-password`        | Authentik | **Pulumi-generated** and set on the `authentik` Cloud SQL user too — one value, no copying by hand |
| `authentik-bootstrap-token`    | Authentik | **Pulumi-generated.** akadmin's API token. The `authentik` Pulumi project authenticates with it    |
| `authentik-bootstrap-password` | Authentik | **Pulumi-generated.** Not a human-facing credential — akadmin's break-glass login only (§8)        |

Dev reads only the `dev-db-<name>-password` secrets that platform's `infra` stack creates. Directus's
and the syncs' secrets are in
[platform's manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md).

## 4. DNS registrar delegation

Cloud DNS managed zones are created in code (`dns.ts`) but are **inert** until each domain's
registrar delegates to the zone's name servers. Look the name servers up after an apply with
`pulumi stack output nameServers`, then set them at the registrar. For the existing external domain,
migrate its current records into the zone _before_ delegating.

- [ ] `cyccommunitysailing.org` (external / public site)
- [x] `cycsail.team` (internal / portals)
- [ ] `cycsailing.center` (link shortener)

## 5. Google OAuth client (`login.cycsail.team`)

A Google OAuth client, read by Authentik's Google source - one of the ways a
family can sign into the CRM or the portal, both of which sit behind Authentik now. Needed before
that source actually serves.

### 5.1 OAuth 2.0 Client ID + consent screen — Google Cloud console

- [x] Consent screen **External** (so personal Google accounts — volunteers, guardians — can sign
      in).
- [x] An OAuth 2.0 Client ID, type **Web application**.
- [ ] Add Authentik's redirect URI: `https://login.cycsail.team/source/oauth/callback/google/`
      (§8).
- [ ] Remove the retired portal redirect URI (`https://cycsail.team/oauth2/callback`) — the portal
      now sits behind Authentik, not oauth2-proxy.
- [ ] Remove the retired Directus redirect URI (`https://directus.cycsail.team/auth/login/google/callback`)
      — Directus signs in through Authentik's `authentik` provider only, not its own Google provider.
- [ ] Copy that client's id/secret into `google-oauth-client-id` / `google-oauth-client-secret`
      (§3).

### 5.2 Domain-wide delegation — Workspace Admin console (retired)

Unused, and no service account holds it. The portal gates on Authentik's `staff` group instead,
assigned by hand, not synced from Workspace.

### 5.3 Access group — Workspace Admin console (retired)

Unused. No longer read by anything.

### 5.4 Groups Administrator role — Workspace Admin console

Moved to [platform's manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md), with gsuite-sync.

## 6. Directus / CRM (`directus.cycsail.team`)

Moved to [platform's manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md), with the `backend` stack.

## 7. Deployer identity and access

Moved to [platform's manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md), with the `bootstrap` stack.

## 8. Authentik (`login.cycsail.team`)

Backing the platform's identity provider. Flows, sources, applications, and groups are a separate
Pulumi project (`packages/infrastructure/src/authentik`, #166).

- [ ] Workspace Admin console → Apps → Google Workspace → Gmail → Routing → SMTP relay service: add
      a rule restricted to the cluster's Cloud NAT static IP (platform's `cluster-nat-*` address),
      accepting mail only for addresses in `cyccommunitysailing.org`. This lets Authentik send as
      `noreply@cyccommunitysailing.org` through `smtp-relay.gmail.com:587` with no credentials — the
      relay authenticates by source IP.
- [ ] The one-time `akadmin` bootstrap password lives in Secret Manager's
      `authentik-bootstrap-password` (§3) — read it with
      `gcloud secrets versions access latest --secret authentik-bootstrap-password --project cyc-admin-scripts`
      if native sign-in is ever unreachable.
- [ ] Authentik's Google source uses the client from §5. Add the redirect URI
      `https://login.cycsail.team/source/oauth/callback/google/` to it. The project's OAuth consent
      screen must be **External**, so families' non-Workspace Google accounts can sign in.

## When you add a new manual step

If you introduce infrastructure that needs an out-of-band action, add it here (and cross-link from
the relevant package README), so this stays the single source of truth for "things I had to do by
hand."

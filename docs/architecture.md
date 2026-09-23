---
tags: [architecture, infrastructure, self-hosted]
---

## Self-hosted platform architecture

This describes a self-hosted operations platform for CYC Community Sailing Center, built on the GCP project
(`cyc-admin-scripts`, `us-west1`) and Pulumi setup this repo already uses. It starts from infrastructure — where
things run, the database, identity, backups, monitoring — then layers on the Clubspot sync and the CRM
as the first two applications.

The guiding split: adopt maintained software for the hard, security-critical parts (login, the permission engine,
the database, backups), and write org-specific glue on top of their APIs. Clubspot stays the registration source of
truth for now; the CRM is a derived, enriched store that everything else reads from.

Data model and table-level design are deliberately out of scope here — those belong in a design doc.

### Principles

- One source of truth per fact. Clubspot owns registration-time data; the CRM owns the org-wide view of people.
- Everything rebuildable from git. Infra in Pulumi, host config declarative, secrets in Secret Manager — never a
  hand-configured box only one person understands.
- Least privilege by default, because this platform holds minors' medical and emergency data.
- Authorization is relationship-based, not just role-based. What you can see depends on how you relate to a record —
  a guardian to their minor, a coach to their event.
- Small bespoke surface. Generate the glue; run maintained platforms for the load-bearing pieces.
- Extend existing patterns (Cloud Run Job + Scheduler + Secret Manager + `GoogleChatNotifier`) instead of inventing
  new ones.

### Target topology

```text
                         Cloud DNS  ──►  TLS endpoint (Caddy on the substrate VM)
                                          │
                          ┌───────────────▼────────────────┐
   staff (Workspace)  ───►│  Google OIDC  +  oauth2-proxy   │   login for everyone;
   coach/guardian     ───►│  (gate for apps w/o native SSO) │   external users on any Google account
   (any Google acct)      └───────────────┬────────────────┘
                                          │
                   ┌──────────────────────┼───────────────────────┐
                   ▼                       ▼                       ▼
             Directus                 coach portal            guardian portal
        (CRM: permission engine   (thin clients calling Directus's API as the signed-in
         + REST/GraphQL API)        user; Directus enforces the rules server-side)
                   │
              Cloud SQL (Postgres, managed backups + PITR)
                   ▲
   Clubspot  ──►  sync job (Cloud Run Job + Scheduler)  ──►  CRM (via Directus API)
   (source of truth)                                              │
                                                        alerts ──► Google Chat webhook
   backups: DB + volumes ──► GCS (versioned, separate region)
   monitoring: Ops Agent + Uptime Checks ──► Cloud Monitoring ──► Google Chat
```

### Committed decisions

- **CRM: Directus.** Chosen for its relationship-based, filter-driven permission engine — the feature
  that expresses "guardian sees their minor's medical" and "coach sees their event's roster" server-side.
- **Identity: Google OIDC directly, no broker.** Everyone signs in with a Google account; no one is forced onto a
  `@cyccommunitysailing.org` address.
- **Compute: a single Compute Engine VM on Container-Optimized OS.** Every surface runs as a container behind Caddy +
  oauth2-proxy. Since the workload is entirely containers, COS (Google-maintained, auto-patching, minimal) fits better
  than NixOS, which would add an image-build pipeline for host-management features the workload doesn't use. GKE is
  out too — Kubernetes is operational overkill at this scale. The compose stack and config live in git; the VM is
  disposable. Running at `e2-medium` (Tier B); resize as needed. The Clubspot sync stays a Cloud Run Job.

## Infrastructure

### Database

**Cloud SQL for PostgreSQL.** One instance holds the app databases; managed backups, point-in-time recovery, and
patching matter most on the one dataset that can't be recreated. Runs on `db-g1-small`; Cloud SQL's shared-core
tier now requires Enterprise edition. Self-hosted Postgres on a VM would be cheaper, but the CRM carries medical
data, so managed durability earns its cost here.

### Identity and authorization

Two separate concerns. Keep them separate.

**Authentication — Google OIDC, direct.** Every app that speaks OIDC (Directus included) points at Google.
oauth2-proxy, also pointed at Google, gates anything without native SSO. No Authentik.

- **Staff** sign in with Workspace accounts. You control MFA and offboarding (disable the account, access is gone).
  Sensitive access — medical and emergency data — is reserved for these accounts.
- **Coaches and guardians** sign in with any Google account. On first login the account is matched to a person
  record (by email) and linked, so authorization rules have an identity to resolve against.
- Authenticating is not authorizing. New logins default to no access; sensitive surfaces are allowlisted (a Google
  Group, or Directus restricted to the Workspace domain).

**Authorization — relationship-based, enforced by Directus.** Access derives from how the signed-in person relates
to a record, not from a static role alone. A guardian can view their own minor's medical information; a coach can
view the rosters of the events they run. Directus's filter-based permission engine evaluates these rules
server-side against the data graph. This is why Directus is the committed choice over a grid tool with coarser
permissions.

If the rules ever outgrow Directus filters — delegated, assistant, or time-boxed access — introduce a dedicated
relationship-based authorization service (OpenFGA or SpiceDB) that the portals query. Not needed to start.

### Secrets

Reuse the Secret Manager pattern from `run-reports-job.ts`. Every credential (database passwords, Directus
key/secret, OIDC client secrets, SES creds later) is a Secret Manager secret granted to the running service
account. Nothing sensitive in git or compose — only references. Pulumi declares the secrets; values are set out of
band.

### Networking, TLS, DNS

- Cloud DNS zone for the chosen domain; a subdomain per surface (`directus.`, coach portal, guardian portal, …).
- TLS via Caddy on the VM.
- Firewall: 443 to the world, SSH restricted to IAP, no database port exposed publicly.

### Backups

Non-negotiable given the data. Target **RPO ≤ 24h** (minutes with PITR) and **RTO of a few hours** (rebuild from
Pulumi + config, restore data).

- **Database**: Cloud SQL automated backups + point-in-time recovery. Also export logical dumps to GCS for a
  provider-independent copy.
- **App volumes**: Directus uploads and any portal assets — `restic`/`borg` to the bucket below.
- **Bucket**: versioned, lifecycle-managed, in a different region, ideally a separate project for blast-radius
  isolation. CMEK if you want to hold the key.
- **Verify**: a restore drill each quarter. A backup you haven't restored is a hope.
- **Alerting**: a dead-man's-switch — if a backup doesn't check in, fire a Google Chat alert via
  `GoogleChatNotifier`.

### Monitoring

Light; you're already in GCP.

- **Metrics and logs** via Ops Agent → Cloud Monitoring / Logging.
- **Uptime** checks against each public surface.
- **Alerts** route to the Google Chat webhook you already use. Add backup-failure and cert-expiry alerts.

### Deploy model

- **Cloud resources** (the VM, Cloud SQL, DNS, Secret Manager, IAM, firewall) extend `packages/infrastructure`.
  `pulumi up` provisions them.
- **App config** lives in git. `pulumi up` re-applies the compose stack over IAP SSH on every run; a fresh VM boots
  it the same way via cloud-init — see `packages/substrate`.
- **Scheduled jobs** (the Clubspot sync) keep the Cloud Run Job + Cloud Scheduler pattern.

## Layer 1: Clubspot integration

A one-way sync: Clubspot → CRM. Clubspot stays authoritative for registration data; the hub enriches and
redistributes it. See `packages/clubspot-sync` for the implementation.

Because the hub — not Clubspot — becomes what the portals, and later Listmonk/Groups/FreeScout, read from, this one
job is the seam that makes an eventual Clubspot replacement a contained change rather than a rebuild.

## Layer 2: CRM

**Directus** on top of the CRM database — the permission engine, the staff admin UI, and the REST/GraphQL API
everything else calls. The data model lives in `docs/crm-schema.md`.

Coaches and guardians are meant to get thin, purpose-built portals instead of admin-UI access: they authenticate via
Google OIDC and call the Directus API _as the signed-in user_, so the relationship rules stay enforced server-side
and the portal itself carries no security logic. Not built yet — coaches currently read rosters through a scoped
Directus role directly (`directus-roles.ts`) as an interim step; guardians have no access until account linking
(identity and authorization, above) lands.

## Data protection

This platform holds minors' medical and emergency information, and — once the portals launch — lets external users
read scoped slices of it. Treat that as the hardest constraint.

- **Encryption at rest** — GCP defaults; CMEK if you want the key. Backups encrypted.
- **Least privilege** — relationship-based rules in Directus, enforced server-side. New logins default to no access.
- **Audit** — Directus activity log for data access/changes; Cloud Audit Logs for infra.
- **Retention** — set and honor a policy for youth data; check COPPA and state requirements before go-live.
- **Access reviews** — revisit group and role membership each season as people rotate.
- **Security review gate** — the guardian medical portal is the highest-liability surface (external parents reading
  medical data). It gets a dedicated security review before launch; the failure mode is one family seeing another's
  information.

## Cost

The platform runs on one VM, one shared-core Cloud SQL instance, and backup storage. Directus, Postgres, Caddy and
oauth2-proxy are all open source, so nothing is licensed per seat. That is the point: the cost stays flat as
volunteers, coaches, and guardians grow, where per-seat SaaS charges for every one of them.

Read current figures from the billing console.

## Phased roadmap

Ordered by permission blast radius: internal and low-stakes first, external access to sensitive data last.

1. **Phase 0 — Infrastructure.** Done: the VM, Cloud SQL, Secret Manager, and DNS/TLS are all live via Pulumi. GCS
   backup export and monitoring are still open (#66).
2. **Phase 1 — Identity.** Done: staff sign in to Directus via Google OIDC; the portal is gated by oauth2-proxy
   restricted to `all@`. Account-to-person linking for coaches and guardians on first login is still open (#65).
3. **Phase 2 — Staff CRM + Clubspot sync.** Done: Directus holds the CRM, staff-only, full access. The Clubspot →
   hub sync job is in progress (#70).
4. **Phase 3 — Coach access.** Not started. The coach portal — rosters for their events, medical hidden — is the
   first real test of relationship-based rules with external-facing users.
5. **Phase 4 — Guardian medical self-service.** Not started, and gated on its own security review regardless.
   Highest liability, so it goes last.
6. **Google Group membership sync.** Done. `packages/gsuite-sync` syncs class and program group membership,
   managers, owners, and settings from the CRM. See `packages/gsuite-sync/README.md`.
7. **Later.** Listmonk (#71), FreeScout (#67) — both reading from the same hub and identity layer.

## Open decisions

- **Portal implementation**: framework and whether to build coach and guardian portals on shared foundations.
- **ReBAC escalation**: whether/when Directus filters give way to OpenFGA/SpiceDB. Revisit if rules get delegated or
  time-boxed.

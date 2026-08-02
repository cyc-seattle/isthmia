---
tags: [architecture, infrastructure, self-hosted]
---

## Self-hosted platform architecture

This describes a self-hosted operations platform for CYC Community Sailing Center, built on the GCP project
(`cyc-admin-scripts`, `us-west1`) and Pulumi setup this repo already uses. It starts from infrastructure — where
things run, the database, identity, backups, monitoring — then layers on the Clubspot sync and the CRM (people hub)
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
                         Cloud DNS  ──►  TLS endpoint (Caddy on a VM, or Cloud Run domain mapping)
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
   Clubspot  ──►  sync job (Cloud Run Job + Scheduler)  ──►  people hub (via Directus API)
   (source of truth)                                              │
                                                        alerts ──► Google Chat webhook
   backups: DB + volumes ──► GCS (versioned, separate region)
   monitoring: Ops Agent + Uptime Checks ──► Cloud Monitoring ──► Google Chat
```

### Committed decisions

- **CRM / people hub: Directus.** Chosen for its relationship-based, filter-driven permission engine — the feature
  that expresses "guardian sees their minor's medical" and "coach sees their event's roster" server-side.
- **Identity: Google OIDC directly, no broker.** Everyone signs in with a Google account; no one is forced onto a
  `@cyccommunitysailing.org` address.

## Infrastructure

### Hosting and compute

Dropping the identity broker removes the one component that fought serverless, so two coherent shapes are now open:

- **Single VM** — one Compute Engine box (start e2-medium) running the always-on apps as containers behind Caddy +
  oauth2-proxy. Simple, cheap, predictable. NixOS (fits your flake) or Container-Optimized OS + compose.
- **Fully managed** — Directus and the portals on Cloud Run (`min-instances=1`), the Clubspot sync as a Cloud Run
  Job, Cloud SQL for data, Cloud Run domain mappings for TLS. No box to patch; higher per-service cost.

Either way the **Clubspot sync stays a Cloud Run Job** (stateless, scheduled — the pattern already in the repo), and
**GKE is out** — Kubernetes is operational overkill at this scale. Pick VM vs. managed on ops preference; both are
reasonable now.

### Database

**Cloud SQL for PostgreSQL** (recommended). One small instance holds the app databases; managed backups,
point-in-time recovery, and patching matter most on the one dataset you can't recreate. Roughly $15–30/month for a
shared-core instance. Self-hosted Postgres on a VM is the budget alternative, but the people hub carries medical
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

- Cloud DNS zone for the chosen domain; a subdomain per surface (`crm.`, coach portal, guardian portal, …).
- TLS via Caddy (VM) or Cloud Run domain mappings (managed).
- Firewall: 443 to the world, SSH restricted to IAP or a known range, no database port exposed publicly.

### Backups

Non-negotiable given the data. Target **RPO ≤ 24h** (minutes with PITR) and **RTO of a few hours** (rebuild from
Pulumi + config, restore data).

- **Database**: Cloud SQL automated backups + point-in-time recovery. Also export logical dumps to GCS for a
  provider-independent copy.
- **App volumes**: Directus uploads and any portal assets — `restic`/`borg` (VM) or GCS-backed storage (managed).
- **Bucket**: versioned, lifecycle-managed, in a different region, ideally a separate project for blast-radius
  isolation. CMEK if you want to hold the key.
- **Verify**: a restore drill each quarter. A backup you haven't restored is a hope.
- **Alerting**: a dead-man's-switch — if a backup doesn't check in, fire a Google Chat alert via
  `GoogleChatNotifier`.

### Monitoring

Light; you're already in GCP.

- **Metrics and logs** via Ops Agent (VM) or built-in Cloud Run metrics → Cloud Monitoring / Logging.
- **Uptime** checks against each public surface.
- **Alerts** route to the Google Chat webhook you already use. Add backup-failure and cert-expiry alerts.

### Deploy model

- **Cloud resources** (VM or Cloud Run services, Cloud SQL, DNS, GCS backup bucket, Secret Manager, IAM, firewall)
  extend `packages/infrastructure`. `pulumi up` provisions them.
- **App config** lives in git; deploy is a NixOS rebuild / `docker compose up -d` (VM) or a Cloud Run deploy
  (managed), pulling images and secrets.
- **Scheduled jobs** (the Clubspot sync) keep the Cloud Run Job + Cloud Scheduler pattern.

## Layer 1: Clubspot integration

A one-way sync: Clubspot → people hub. Clubspot stays authoritative for registration data; the hub enriches and
redistributes it.

Reuse what exists. `clubspot-sdk` already authenticates and reads camp registrations; `admin-functions` already
models camps, registrations, participants, sessions, and roster. The sync is a new entry point over that code,
packaged like `run-reports-job`:

- **Trigger**: Cloud Run Job + Cloud Scheduler (start daily; go hourly like the reports job if you want it fresher).
- **Credentials**: the existing `clubspot-username` / `clubspot-password` secrets.
- **Work**: pull current registrations → upsert the people, relationships, and enrollments into the hub through the
  Directus API.
- **Idempotent**: key every record on a stable Clubspot ID; re-running never duplicates.
- **Observability**: log to Cloud Logging; on failure, post to Google Chat via `GoogleChatNotifier`.

Because the hub — not Clubspot — becomes what the portals, and later Listmonk/Groups/FreeScout, read from, this one
job is the seam that makes an eventual Clubspot replacement a contained change rather than a rebuild.

## Layer 2: CRM / people hub

**Directus** on top of the people-hub database. Directus is the permission engine, the admin UI for staff, and the
REST/GraphQL API everything else calls. The data model is deferred to a design doc; what matters at this level:

- **Staff** use the Directus admin UI directly, with full access including medical and emergency data.
- **Coaches and guardians do not.** They get thin, purpose-built portals that authenticate via Google OIDC and call
  the Directus API _as the signed-in user_. Directus enforces the relationship rules server-side, so the portal is a
  dumb client and the security lives in the tested engine — not in hand-written portal code over medical data.
- Portals are small enough to be strong candidates for AI-assisted development, since the hard part (authorization)
  sits in Directus, not in them.

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

## Cost estimate

- Compute: single VM ~$25–50/month, or managed Cloud Run services in a similar range at this scale
- Cloud SQL (shared-core): ~$15–30/month
- SSD / GCS backups: ~$5–15/month
- Software (Directus, Postgres, Caddy, oauth2-proxy): $0

Roughly **$45–75/month** for the starting platform, flat as volunteers, coaches, and guardians grow — versus
per-seat SaaS that charges for every one of them.

## Phased roadmap

Ordered by permission blast radius: internal and low-stakes first, external access to sensitive data last.

1. **Phase 0 — Infrastructure.** Compute (VM or Cloud Run), Cloud SQL, backups to GCS, monitoring, Google Chat
   alerts. All GCP resources in Pulumi.
2. **Phase 1 — Identity.** Google OIDC wired into the apps + oauth2-proxy gate. Staff on Workspace, external users on
   any Google account, account-to-person linking on first login.
3. **Phase 2 — Staff CRM + Clubspot sync.** Directus on the people hub, staff-only, full access. The Clubspot → hub
   sync job. First real payoff: the spreadsheet becomes a permissioned database fed automatically.
4. **Phase 3 — Coach access.** The coach portal — rosters for their events, medical hidden. Lower stakes, and the
   first real test of relationship-based rules with external-facing users.
5. **Phase 4 — Guardian medical self-service.** The guardian portal, behind its security-review gate. Highest
   liability, so it goes last.
6. **Later.** Listmonk (newsletter via SES), Google Group membership sync, FreeScout (shared inbox) — all reading
   from the same hub and identity layer.

## Open decisions

- **Compute shape**: single VM vs. fully managed Cloud Run. Both viable now that the broker is gone; decide on ops
  preference.
- **Directus hosting**: on the VM or on Cloud Run, if you go the VM route for other apps.
- **Portal implementation**: framework and whether to build coach and guardian portals on shared foundations.
- **ReBAC escalation**: whether/when Directus filters give way to OpenFGA/SpiceDB. Revisit if rules get delegated or
  time-boxed.

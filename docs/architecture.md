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
- Everything rebuildable from git. Infra and workloads in Pulumi, and no secret values in git — never a
  hand-configured box only one person understands.
- Least privilege by default, because this platform holds minors' medical and emergency data.
- Authorization is relationship-based, not just role-based. What you can see depends on how you relate to a record —
  a guardian to their minor, a coach to their event.
- Small bespoke surface. Generate the glue; run maintained platforms for the load-bearing pieces.
- Extend existing patterns (`@cyc-seattle/platform`'s `WebService`, `Workload`, and `ScheduledJob`, with Kubernetes
  Secrets) instead of inventing new ones.

### Target topology

```text
                         Cloud DNS  ──►  GKE Gateway (TLS, routes by hostname)
                                          │
                          ┌───────────────▼────────────────┐
   staff (Workspace)  ───►│  Google OIDC  +  Authentik      │   login for everyone;
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
   Clubspot  ──►  sync job (Kubernetes CronJob)  ──►  CRM (via Directus API)
   (source of truth)
   backups: DB ──► GCS (versioned, separate region)
   monitoring: Cloud Logging ──► Cloud Monitoring alerts ──► email
```

### Committed decisions

- **CRM: Directus.** Chosen for its relationship-based, filter-driven permission engine — the feature
  that expresses "guardian sees their minor's medical" and "coach sees their event's roster" server-side.
- **Identity: Authentik**, at `login.cycsail.team`. Everyone signs in with a Google account or an emailed link; no one
  is forced onto a `@cyccommunitysailing.org` address.
- **Compute: GKE Autopilot**, from [platform](https://github.com/cyc-seattle/platform)'s `cluster` stack (#231).
  Every surface runs as a container in its environment's namespace, behind the shared Gateway. The portal sits
  behind Authentik's forward-auth outpost. The syncs are CronJobs.

## Infrastructure

### Database

**Cloud SQL for PostgreSQL.** One instance holds the app databases; managed backups, point-in-time recovery, and
patching matter most on the one dataset that can't be recreated. Runs on `db-g1-small`; Cloud SQL's shared-core
tier now requires Enterprise edition. Self-hosted Postgres on a VM would be cheaper, but the CRM carries medical
data, so managed durability earns its cost here.

**Dev's connection budget (#268).** Dev's instance, `cyc-dev`, is a `db-f1-micro`, with 25 connections. Three are
reserved for superusers, and Cloud SQL's own agent (`cloudsqladmin`) holds two, which leaves about 20 for the apps:

| Database        | Holds                                             | Most |
| --------------- | ------------------------------------------------- | ---- |
| `authentik`     | PgBouncer's pool (3), plus the direct connections | ~11  |
| `directus`      | `DB_POOL__MAX` of 4, plus one                     | 5    |
| `clubspot_fake` | Parse's pool, `?max=2` on its URI                 | 2–3  |

Authentik's connections don't follow its worker and thread settings. Each in-flight request holds its own
connection, `AUTHENTIK_WEB__THREADS` doesn't apply to its Uvicorn workers, and the Rust core and the Channels layer
each keep a pool of up to four. So in dev, Authentik reaches its database through PgBouncer in transaction mode,
which opens at most three connections. The connections that need a session (the Channels layer, the worker's
`LISTEN` and advisory locks) go to Cloud SQL directly, through `AUTHENTIK_POSTGRESQL__DIRECT__HOST`. Prod connects
directly, with no pooler. Watch the `database/postgresql/num_backends` metric, by database, to check the budget.

### Identity and authorization

Two separate concerns. Keep them separate.

**Authentication — Authentik.** Every app that speaks OIDC (Directus included) points at Authentik, which signs a
user in through Google or an emailed link. Authentik's forward-auth outpost gates anything without native SSO, such
as the portal.

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

Pods read Kubernetes Secrets that Pulumi writes, and never call Secret Manager, so a pod needs no IAM for its
secrets.

- **Generated values** (database passwords, Directus's key and secret, tokens, OIDC client secrets) are `random`
  resources in the owning project's state, encrypted by that environment's KMS key.
- **Hand-set values** (the Directus license key, the Google OAuth client, the Clubspot login) stay in Secret
  Manager, set out of band. The deploy reads them. Dev's have a `dev-` prefix.

Nothing sensitive is in git. `docs/manual-setup.md` §3 lists each secret.

### Networking, TLS, DNS

- Cloud DNS zone for the chosen domain; a subdomain per surface (`directus.`, coach portal, guardian portal, …).
- TLS at the GKE Gateway, with a Certificate Manager certificate from platform's `cluster` stack.
- Cloud SQL has only a private IP. No database port is exposed publicly.

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

- **Logs** from every pod go to Cloud Logging. `mise run logs` tails a workload's.
- **Job alerts**, from platform's `cluster` stack: any prod Job that fails, and any CronJob with no successful run in
  3 hours, emails the maintainer.
- **Still open:** uptime checks against each public surface, and backup-failure and cert-expiry alerts.

### Deploy model

- **Shared cloud resources** (the VPC, Cloud SQL, DNS zones, the cluster, IAM) live in
  [platform](https://github.com/cyc-seattle/platform).
- **Apps** are Pulumi projects in `packages/infrastructure`, each deploying its workloads to the cluster: `authentik`,
  `crm`, `portal`, `clubspot-sync`, and `gsuite-sync`. Actions deploys dev on every pull request, and prod from
  `main` after a maintainer approves. Prod runs the image digest dev built for the same commit.
- **Scheduled jobs** (the syncs) are Kubernetes CronJobs, hourly.
- **Environments.** `prod` and `dev` are namespaces in the one cluster. Prod runs on regular capacity, dev on Spot
  pods, with synthetic data, Mailpit, and the Clubspot and Workspace fakes.
- **Availability.** The portal runs 2 replicas in prod. Directus and Authentik's server run one each, which
  Autopilot won't move to consolidate nodes. A second Directus needs Redis, to share its caches (#253).

## Layer 1: Clubspot integration

A one-way sync: Clubspot → CRM. Clubspot stays authoritative for registration data; the hub enriches and
redistributes it. See `packages/clubspot-sync` for the implementation.

Because the hub — not Clubspot — becomes what the portals, and later Listmonk/Groups/FreeScout, read from, this one
job is the seam that makes an eventual Clubspot replacement a contained change rather than a rebuild.

## Layer 2: CRM

**Directus** on top of the CRM database — the permission engine, the staff admin UI, and the REST/GraphQL API
everything else calls. The data model lives in `docs/crm-schema.md`.

The relationship rules need a Directus license (#172), which both prod and dev hold. A hook extension,
`community-query-guard` (`packages/infrastructure/src/crm/`), rejects a Community query that filters or sorts on a
field the viewer can't read on every row, since Directus's own checks would let it probe hidden values.

Coaches and guardians are meant to get thin, purpose-built portals instead of admin-UI access: they authenticate via
Google OIDC and call the Directus API _as the signed-in user_, so the relationship rules stay enforced server-side
and the portal itself carries no security logic. Not built yet — coaches currently read rosters through a scoped
Directus role directly (`packages/infrastructure/src/directus/roles.ts`) as an interim step; guardians have no access until account linking
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

The platform runs on one GKE Autopilot cluster, one shared-core Cloud SQL instance, and backup storage. Directus,
Authentik, Postgres, and Caddy are all open source, so nothing is licensed per seat. That is the point: the cost stays flat as
volunteers, coaches, and guardians grow, where per-seat SaaS charges for every one of them.

Read current figures from the billing console.

## Phased roadmap

Ordered by permission blast radius: internal and low-stakes first, external access to sensitive data last.

1. **Phase 0 — Infrastructure.** Done: the cluster, Cloud SQL, Secret Manager, and DNS/TLS are all live via Pulumi. GCS
   backup export and monitoring are still open (#66).
2. **Phase 1 — Identity.** Done: staff sign in to Directus via Google OIDC; the portal is gated by Authentik.
   Account-to-person linking for coaches and guardians on first login is still open (#65).
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

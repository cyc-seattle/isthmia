# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

Isthmia is a pnpm monorepo of TypeScript packages that run operations for the CYC Community
Sailing Center. It integrates with Clubspot (a sailing club management platform) and Google
Workspace, and it deploys automated jobs to Google Cloud Platform.

## Development environment

mise provides the tools in `mise.toml`.

1. Activate mise in your shell: `eval "$(mise activate zsh)"` (or `bash`) in your shell rc. See
   [Getting started](https://mise.jdx.dev/getting-started.html). Without it,
   `GOOGLE_APPLICATION_CREDENTIALS` and `node_modules/.bin` exist only inside `mise run` and
   `mise exec`, so the CLI tools and bare `vitest` fail.
2. Run `mise trust`.
3. Run `mise run install` to install the tools, `node_modules`, and the Pulumi SDKs.

Run `mise tasks` to list every task. The common ones:

- `mise run ci` — the CI checks: `check`, then `test`
- `mise run build` — install, then build every package with `tsc --build`
- `mise run check` — format check, lint, build, test type checks, and the Dockerfile manifest check
- `mise run format` — fix formatting with Prettier and ESLint
- `mise run test` — run the tests with vitest
- `mise run clean` — delete build output
- `mise run directus-local` — run Directus and Postgres locally with every package's schema applied
- `mise run doctor` — check auth, tooling, and Docker, and fix what it can
- `mise run deploy` — build, then deploy `$PULUMI_STACK`'s Pulumi projects (needs authorization)
- `mise run preview` — show what `deploy` would change, without changing it
- `mise run db-shell <database>` — `psql` on one of `$PULUMI_STACK`'s databases, from the cluster
- `mise run integration` — the integration features, against dev (see [Testing](#testing))
- `mise run reset` — empty dev's CRM, reseed its fakes, and run both syncs

## Working in this repo

The shared skills and agents live in
[`cyc-seattle/agent-skills`](https://github.com/cyc-seattle/agent-skills). Its README says how to
install them.

- Plans live on GitHub issues. `.plans/` is git-ignored, for local drafts.
- PR titles are conventional commits. PRs merge by squash.
- Never push to `main`.

This repo has two skills of its own in `.agents/skills/`: `cleanup-duplicate-people` and
`cleanup-schools`. Each works through one kind of CRM data problem. Each proposes a code fix that
stops the problem recurring, then per-row edits for the user to approve.

Claude Code reads skills only from `.claude/skills`. Claude Code users link them there once:

```sh
mkdir -p .claude && ln -s ../.agents/skills .claude/skills
```

## Architecture

### Package structure

```
packages/
├── crm/                  # The canonical domain: schema.yaml and its row types. No jobs.
├── clubspot/             # The Clubspot-shaped schema.yaml and row types. No jobs.
├── directus/             # Infrastructure shared by every sync: the Directus REST client and durable task queue
├── clubspot-sync/        # Cloud Run job that syncs Clubspot data into the CRM's Directus instance
├── gsuite-sync/          # Cloud Run job that syncs the CRM into Google Workspace groups
├── infrastructure/       # Pulumi-based GCP deployment configuration
├── portal/               # Static link portal served at cycsail.team, gated by Google auth
└── substrate/            # The substrate VM's shared front door (Caddy, fronting every app)
```

The spreadsheet-to-calendar sync lives in
[`cyc-seattle/calendar-sync`](https://github.com/cyc-seattle/calendar-sync), and the break-glass GAM
scripts for Google Workspace in [`cyc-seattle/gam`](https://github.com/cyc-seattle/gam).

### Dependency graph

`portal` and `substrate` are apps that `infrastructure` deploys, not libraries. `crm`,
`clubspot`, and `directus` are infrastructure that other packages build on:

- `crm` owns the canonical Directus schema and exports its row types. It has no jobs.
- `clubspot` does the same for the Clubspot-shaped collections. It depends on `crm` for
  `PersonRow`, never the reverse.
- `directus` owns the REST client and the durable task queue that every sync job runs on. It must
  not depend on `crm` or `clubspot`.

```
@cyc-seattle/commodore (npm: CLI and logging helpers)
    ↑
    ├── @cyc-seattle/clubspot-sdk (npm: Parse SDK wrapper for TheClubSpot API)
    │       ↑
    │       └── clubspot-sync
    ├── clubspot-sync (Clubspot <-> crm/clubspot; also depends on clubspot-sdk, directus)
    └── gsuite-sync (Google Workspace <-> crm/clubspot; also depends on directus, gsuite-sdk)

@cyc-seattle/gsuite-sdk (npm: Google Workspace API wrappers)
    ↑
    └── gsuite-sync (uses the Directory and Groups Settings clients)

crm (canonical schema and row types — no dependencies of its own)
clubspot (Clubspot-shaped schema and row types — depends on crm for PersonRow)
directus (Directus REST client and task queue — no dependencies of its own)

infrastructure (deploys clubspot-sync and gsuite-sync as Cloud Run jobs, plus crm, portal, and substrate)
```

### Canonical collections and providers

Directus holds the canonical model. Each SaaS product gets a sync package that maps the model onto
that product. **A canonical collection describes the org. Anything specific to one product belongs
to that product's package.** "Fred is a Parent Coordinator of J-Pod" is canonical, in `crm`.
"Anyone holding a program role is a member of that program's Google Group" is `gsuite-sync`'s own
mapping.

A provider may add a field to a collection it doesn't own. `programs.google_group_id` is a column
on `programs`, declared in `gsuite-sync`'s `schema.yaml`, not `crm`'s. `directus` extends `people`
the same way, for `people.directus_user_id`. The rule follows collection ownership, so a field on
a `clubspot` collection declared elsewhere is an extension too.

**Every package's `schema.yaml` is merged into one snapshot and applied once** (`mergeSchemas`,
`packages/infrastructure/src/directus/client.ts`). Never apply them one package at a time. A
package's own apply drops any extension field it doesn't declare, and that column's data with it.

### Key components

- **commodore** — shared CLI and logging (commander.js, winston), published from
  [`cyc-seattle/commodore`](https://github.com/cyc-seattle/commodore). CLI tools depend on it from npm.
- **gsuite-sdk** — Google Workspace wrappers, published from
  [`cyc-seattle/gsuite-sdk`](https://github.com/cyc-seattle/gsuite-sdk) and used from npm: `CalendarClient`, the typed Sheets classes
  (`SpreadsheetClient`, `Spreadsheet`, `Worksheet`, `Table`), and `safeCall`, which rate-limits
  and retries with exponential backoff.
- **clubspot-sdk** — the `Clubspot` class authenticates to TheClubSpot's Parse backend and gives
  typed access to its cloud functions and queries. Published from
  [`cyc-seattle/clubspot-sdk`](https://github.com/cyc-seattle/clubspot-sdk) and used from npm.
- **crm** — people, contacts, medical profiles, programs, and program roles. See
  `docs/crm-schema.md` and `packages/crm/README.md`.
- **clubspot** — `camps`, `sessions`, `classes`, and the registration and custom-field
  collections. See `packages/clubspot/README.md`.
- **directus** — `DirectusClient` and the `sync_tasks` queue that a sync job talks to at runtime.
  Its `schema.yaml` declares `sync_tasks` and `audit_findings`. Not the same as
  `packages/infrastructure/src/directus/`, which holds the Pulumi classes that apply schemas.
- **clubspot-sync** — syncs one Clubspot club's camps, schedule, and registrations into Directus.
  Each collection's mapping is a pure plan function with a thin executor that writes to Directus.
  See `packages/clubspot-sync/README.md`.
- **gsuite-sync** — syncs program group membership, owners, and settings into Google Groups, in
  the same shape as clubspot-sync. See `packages/gsuite-sync/README.md`.
- **infrastructure** — six Pulumi projects under `src/`, described in [Deployment](#deployment).
  `src/directus/` holds the `Directus*` resource classes and the CRM's roles, which
  `infrastructure` and `crm` share. `src/cluster.ts` holds what every on-cluster project shares.
- **portal** — a static site that gives staff and volunteers one bookmark for their tools. Caddy
  serves it, and Authentik gates it. Its `Dockerfile` is the image the cluster runs.
- **substrate** — one Caddy container that terminates TLS for every app on the substrate VM and
  routes by hostname.

## Authentication

There are two independent auth systems. Do not confuse them.

### Access policy (least privilege)

Only the Workspace super-admin accounts, `master@` and `commander@` (planned), hold root control
of the GCP project and Google Workspace. Use them only for configuration changes: org policy,
project-root IAM, enabling services by hand, and Workspace settings.

Deployers use their own accounts and never a super-admin's credentials. Project `roles/owner` on
`cyc-admin-scripts` is what makes `pulumi up` work. platform's
[manual setup](https://github.com/cyc-seattle/platform/blob/main/docs/manual-setup.md) says how to grant it.

The scoped `deployer` role in [platform](https://github.com/cyc-seattle/platform)'s `bootstrap` stack is for `deploy-runner`, the
service account that GitHub Actions assumes (#118), not for people. A CI workflow must not be able
to grant itself Owner.

### Google Cloud (Sheets, Calendar, deploys)

Google APIs use two credential types for two purposes:

| Purpose                                 | Credential                                | Command                                                       | Used by                                                    |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Deploying                               | **User credentials**                      | `gcloud auth login` (`mise run auth-gcp`)                     | the `gcloud` CLI                                           |
| Deploying, and running the jobs locally | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (`mise run auth-adc`) | `pulumi`, `docker`, and `google-auth-library` in the tools |

Log in with your own account for both. Never log in as a super-admin for development.

Each deployed job runs as its own service account, not as your ADC identity, so a local run may see
different access than production.

### Authentik (`login.cycsail.team`)

Authentik is the sign-in for the portal and Directus, by Google or an emailed link. Its `staff`
group gates the portal's staff sections. It is managed by hand, not synced from Workspace.

### TheClubSpot (Parse backend)

TheClubSpot auth is separate from Google. It uses a username and password:

- Locally, they come from `CLUBSPOT_EMAIL` and `CLUBSPOT_PASSWORD`, or `-u` for the username. The
  password has no short flag, and `--password` is hidden, because a secret on argv leaks into `ps`
  and shell history (#49).
- In production, they come from the Secret Manager secrets `clubspot-username` and
  `clubspot-password`.

The SDK looks up the user by email, logs in, and keeps the session in memory with Parse's "unsafe
current user" mode.

## Deployment

Pulumi projects live under `packages/infrastructure/src/`, each with a stack per environment.
`mise run deploy` applies `$PULUMI_STACK`'s projects in order, through `scripts/each-stack`:

- **prod**, still on the substrate VM:
  1. `infrastructure`, through the db tunnel: the VM and what runs on it (Directus and Authentik,
     their databases and secrets), the Cloud Run jobs, the DNS records, and the CRM's roles and users
  2. `authentik`: Authentik's sign-in flows, sources, and applications
  3. `crm`: the merged Directus schema and permission rules, which need the roles from
     `infrastructure`
- **dev**, on the GKE cluster (#231):
  1. `authentik`: Authentik itself, its database and secrets, Mailpit, and its configuration
  2. `crm`: Directus, its database and secrets, its roles and users, and the schema and rules
  3. `portal`: Caddy and the static site, with `forward_auth` to `authentik-server`
  4. `clubspot-sync`: the CronJob, the Clubspot fake, and the fake's database
  5. `gsuite-sync`: the CronJob and the Workspace fake

A project runs its workloads on the cluster only when its stack sets `<project>:onCluster: true`.
Each prod stack sets it in that project's move, so until then prod runs as before. Mailpit and the
fakes exist only in the `dev` stack. Each app reads the next through a StackReference in the same
environment: `crm` reads `authentik`'s `directusOidcClientSecret`, and the syncs read `crm`'s tokens.

On the cluster, generated values (keys, passwords, tokens) are `random` resources written to
Kubernetes Secrets. Hand-set values stay in Secret Manager, dev's with a `dev-` prefix, and the
deploy reads them. In dev, platform's `cloud` stack creates the databases and users, and keeps
each password in Secret Manager as `dev-db-<name>-password`: Cloud SQL ignores IAM conditions on
user and database calls, so `deploy-dev` holds no Cloud SQL role. In prod, each project creates its
own through the Cloud SQL Admin API, so no deploy needs a route to Postgres. `mise run db-shell
<database>` opens `psql` from a throwaway pod in the namespace.

[platform](https://github.com/cyc-seattle/platform) holds what no app owns. `infrastructure` reads
two of its stacks through StackReferences: `bootstrap` (the identities, the state buckets, and the
org's GitHub settings) and `cloud` (the VPC, the Cloud SQL instance, the DNS zones, and Artifact
Registry). The on-cluster projects use `@cyc-seattle/platform`'s `WebService`, `Workload`, and
`ScheduledJob`, and read the environment's cluster, Gateway, domain, database, and registry from
its outputs. A pull request's Actions run deploys dev; prod still deploys from a laptop.

State lives in GCS, one bucket per environment, with secrets encrypted by a KMS key. `mise.toml` sets `PULUMI_BACKEND_URL` from `PULUMI_STACK`, which
defaults to `prod`. Without mise's env, `pulumi` uses whatever backend it last logged in to.

From a laptop, `mise run deploy` needs:

1. `mise run auth-gcp`, as a deployer
2. project `roles/owner` on `cyc-admin-scripts`, and a place in platform's
   `bootstrap:humanDeployers` for the state bucket and key

The `authentik` project's SDK (`@pulumi/authentik`) is generated into git-ignored `generated/` by
`scripts/gen-sdks`, which `mise run install` runs.

The deploy builds every package, builds Docker images for clubspot-sync and gsuite-sync (and in
dev, the portal), pushes them to Artifact Registry (us-west1), and runs Pulumi. On the cluster,
images are tagged with the commit SHA. The image push authenticates with an OAuth2 token
from the running credentials. It builds on the first buildx builder it can reach, so colima, Docker
Desktop, or a native daemon all work. The deploy unsets `DOCKER_HOST`, which the provider would
otherwise record in state (#208).

## Testing

- Tests run with vitest: `mise run test`, or `vitest` for watch mode.
- Test files live at `packages/*/test/**/*.test.ts`, in a top-level `test/` directory per package.
- Mock the external SDK boundary (Parse, google-spreadsheet, googleapis) and test pure logic.
  `packages/clubspot-sync/test/parse-paging.test.ts` is the pattern: a hand-rolled fake Parse query
  and no live Clubspot API.

### Integration features

`mise run integration` runs the Gherkin features in `features/` against the deployed dev
environment, as whatever identity ADC holds. A pull request's `dev` job runs them as `deploy-dev`
after its deploy. They never run in `mise run ci`.

- Steps live in `test/features/`. vitest runs `*.test.ts` through `@amiceli/vitest-cucumber`.
  `sign-in.feature` is a browser journey, which `playwright-bdd` runs from `sign-in.steps.ts`.
- They reach the fakes and Mailpit through the Kubernetes API's service proxy, and Directus and
  Authentik at their dev hostnames. Nothing test-only is on the Gateway.
- Each scenario names its data with a run ID, so runs never depend on each other. The data stays
  until `mise run reset`, or the `reset-dev` workflow, empties it.
- `community-rules.feature` checks the Community role's rules on dev's licensed Directus (#172).

## Code style

- TypeScript with `@tsconfig/strictest`
- ESLint with Prettier
- ESM (`"type": "module"`) everywhere except `packages/infrastructure`, which is CommonJS
- Import paths in ESM packages carry the `.js` extension.

### Comments

Comments explain **why**, not what. Keep them to a line or two. Write one where a reader would
otherwise get it wrong: a non-obvious constraint, a surprising API behavior, or a decision that
looks arbitrary but isn't.

- Don't narrate the code, restate the diff, or argue for the approach you chose.
- Cite an issue (`#107`) instead of recounting its discussion.
- Don't cite a local plan file. A `docs/` reference is fine.
- Test each comment: if you deleted it, would a competent reader still make the same change
  correctly? If yes, delete it.

The same applies to docs:

- **Record the outcome, not the path to it.** Say what to do today, not what failed on the way.
- **No personal identifiers.** Use a role name or `<placeholder>` instead of an email address or a
  numeric account ID. Where a command needs a literal, use it once.

Many existing comments predate this policy. Trim them when you touch that code for another reason.

## Review checks

The shared reviewer checks these, in addition to its own checklist:

- **Two auth systems.** Google and TheClubSpot auth stay separate. User credentials are for
  deploys, and ADC is for running tools. Clubspot credentials come from env vars locally and from
  Secret Manager in production, never a committed flag. No code logs in as a super-admin, and no
  long-lived service account keys.
- **Least-privilege IAM.** New grants are least-privilege.
- **Pulumi resource subclasses.** A resource is a subclass with secure defaults and explicit grant
  methods.
- **ESM imports.** Import paths carry `.js`, except in CommonJS `packages/infrastructure`.
- **SDK boundary.** Tests mock Parse, google-spreadsheet, and googleapis instead of calling a live
  API.
- **Planning schema diagrams.** A change to the planning design or its collections updates the ER
  diagrams in `docs/planning-schema.md` in the same PR.
- **Schema changes are serialized.** Two parallel changes to any `packages/*/schema.yaml` conflict.
  Make them one after the other.
- **Dependency graph.** Changes respect the graph above.

## Important technical details

- **Parse SDK.** clubspot-sdk (an npm dependency) calls `Parse.User.enableUnsafeCurrentUser()`. Parse needs it to keep
  the session for later API calls.
- **Node engine.** Packages that declare `engines.node` require `">= 20.8 < 23"`, to match Node.js
  22 in mise and the Docker base image.
- **Security overrides.** `pnpm-workspace.yaml` has pnpm overrides for vulnerable transitive
  dependencies.
- **Directus license activations are limited.** The key allows 5 activations, and they ran out once
  (#172). Directus spends one each time it starts with a license key on an instance it hasn't seen:
  a new database or a new `PUBLIC_URL`. A restart, redeploy, or reset that keeps both spends none.
  - Never give a license key to a throwaway Directus. Each run of `mise run directus-community-test`
    or its workflow spends one, unless `KEEP=1` reuses the instance from the last run.
  - Never drop, recreate, or rename dev's or prod's Directus database, and never change its
    `PUBLIC_URL`. Moving prod to the cluster must keep both.
  - Ask the maintainer before any change that could activate a new instance.

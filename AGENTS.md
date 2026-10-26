# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

Isthmia is a pnpm monorepo of TypeScript packages that run operations for the CYC Community
Sailing Center. It deploys Authentik, the sign-in for staff and families, and the portal to Google
Cloud Platform. Directus, its schema, and the Clubspot and Google Workspace syncs live in
[platform](https://github.com/cyc-seattle/platform)'s `backend` stack (cyc-seattle/workplace#6).

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
- `mise run doctor` — check auth, tooling, and Docker, and fix what it can
- `mise run deploy` — build, then deploy `$PULUMI_STACK`'s Pulumi projects (needs authorization)
- `mise run preview` — show what `deploy` would change, without changing it
- `mise run db-shell <database>` — `psql` on one of `$PULUMI_STACK`'s databases, from the cluster
- `mise run integration` — the integration features, against dev (see [Testing](#testing))

## Working in this repo

The shared skills and agents live in
[`cyc-seattle/agent-skills`](https://github.com/cyc-seattle/agent-skills). Its README says how to
install them.

- Plans live on GitHub issues. `.plans/` is git-ignored, for local drafts.
- PR titles are conventional commits. PRs merge by squash.
- Never push to `main`.

## Architecture

### Package structure

```
packages/
├── infrastructure/       # Pulumi-based GCP deployment configuration
└── portal/               # Static link portal served at cycsail.team, gated by Authentik
```

`portal` is an app that `infrastructure` deploys, not a library. The portal reads Directus by URL,
at `directus.<domain>`, and imports nothing from platform.

The spreadsheet-to-calendar sync lives in
[`cyc-seattle/calendar-sync`](https://github.com/cyc-seattle/calendar-sync), and the break-glass GAM
scripts for Google Workspace in [`cyc-seattle/gam`](https://github.com/cyc-seattle/gam).

### Key components

- **infrastructure** — two Pulumi projects under `src/`, described in [Deployment](#deployment).
  `src/cluster.ts` holds what every project shares.
- **portal** — a static site that gives staff and volunteers one bookmark for their tools. Caddy
  serves it, and Authentik gates it. Its `Dockerfile` is the image the cluster runs.

## Authentication

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

### Google Cloud (deploys)

Google APIs use two credential types for two purposes:

| Purpose                                 | Credential                                | Command                                                       | Used by                                                       |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Deploying                               | **User credentials**                      | `gcloud auth login` (`mise run auth-gcp`)                     | the `gcloud` CLI                                              |
| Deploying, and the integration features | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (`mise run auth-adc`) | `pulumi`, `docker`, and `google-auth-library` in the features |

Log in with your own account for both. Never log in as a super-admin for development.

### Authentik (`login.cycsail.team`)

Authentik is the sign-in for the portal and Directus, by Google or an emailed link. Its `staff`
group gates the portal's staff sections. It is managed by hand, not synced from Workspace.

## Deployment

Pulumi projects live under `packages/infrastructure/src/`, each with a stack per environment.
`mise run deploy` applies `$PULUMI_STACK`'s projects in order, through `scripts/each-stack`. Both
`dev` and `prod` run on the GKE cluster (#231), each in its own namespace:

1. `authentik`: Authentik itself, its database, secrets, and record, and its configuration
2. `portal`: Caddy and the static site, with `forward_auth` to `authentik-server`

Platform's `backend` stack deploys Directus, its schema, roles, and users, and clubspot-sync and
gsuite-sync, in both environments. Their code moved there from this repo (cyc-seattle/workplace#6).

Mailpit exists only in the `dev` stack. `authentik` reads Directus's OIDC client ID and secret from
platform's `backend` stack in the same environment, through a StackReference.

Prod runs on regular capacity, and dev on Spot. In prod, the portal runs one replica.
`authentik-server` runs one replica, marked `safe-to-evict: "false"` so Autopilot doesn't move it
to consolidate nodes.

Generated values (keys, passwords, tokens) are `random` resources written to
Kubernetes Secrets. Prod's also keep the Secret Manager copies they had on the VM. Hand-set values stay in Secret Manager, dev's with a `dev-` prefix, and the
deploy reads them. In dev, platform's `infra` stack creates the databases and users, and keeps
each password in Secret Manager as `dev-db-<name>-password`: Cloud SQL ignores IAM conditions on
user and database calls, so `deploy-dev` holds no Cloud SQL role. In prod, each project creates its
own through the Cloud SQL Admin API, so no deploy needs a route to Postgres. `mise run db-shell
<database>` opens `psql` from a throwaway pod in the namespace.

[platform](https://github.com/cyc-seattle/platform) holds what no app owns: `bootstrap` (the
identities, the state buckets, and the org's GitHub settings), `infra` (the VPC, the Cloud SQL
instance, the DNS zones, Artifact Registry, the cluster, and the Gateway). The projects use
`@cyc-seattle/platform`'s `WebService`, `Workload`, and `ScheduledJob`, read the environment's
cluster, Gateway, domain, database, and registry from its outputs, and write their A records into
`infra`'s zone.

Deploys run from Actions (#118). A pull request deploys dev. A push to `main` deploys dev, then
runs `prod-preview`, then `prod`, which waits for a maintainer's approval and is skipped when the
preview shows no changes. `each-stack preview` reports each project's changes through
`DEPLOY_CHANGES_FILE`. Dev builds a new image digest on every commit, so every merge's preview
shows an image update for the portal until #258.

A pull request deploys only the dev projects whose inputs it changes, plus the projects that read
them (`scripts/changed-projects`). One that changes only tests, features, or docs deploys nothing.
`main` deploys every project. Dev is shared, so it may still run another branch's version of a
project this PR didn't deploy.

State lives in GCS, one bucket per environment, with secrets encrypted by a KMS key. `mise.toml` sets `PULUMI_BACKEND_URL` from `PULUMI_STACK`, which
defaults to `prod`. Without mise's env, `pulumi` uses whatever backend it last logged in to.

A laptop deploy is the break-glass path. From a laptop, `mise run deploy` needs:

1. `mise run auth-gcp`, as a deployer
2. project `roles/owner` on `cyc-admin-scripts`, and a place in platform's
   `bootstrap:humanDeployers` for the state bucket and key

The `authentik` project's SDK (`@pulumi/authentik`) is generated into `generated/` by
`scripts/gen-sdks` and committed, so a lockfile update works without it. `mise run install`
regenerates it when the provider or Pulumi version changes, and `mise run check` fails until the
result is committed.

The deploy builds every package, builds the portal's Docker image in dev, pushes it to Artifact
Registry (us-west1), and runs Pulumi. Images are
tagged with the commit SHA, and prod runs the image dev built for its commit. The image push authenticates with an OAuth2 token
from the running credentials. It builds on the first buildx builder it can reach, so colima, Docker
Desktop, or a native daemon all work. The deploy unsets `DOCKER_HOST`, which the provider would
otherwise record in state (#208).

## Testing

- Tests run with vitest: `mise run test`, or `vitest` for watch mode.
- Test files live at `packages/*/test/**/*.test.ts`, in a top-level `test/` directory per package.
- Mock the external boundary (Pulumi's runtime, `fetch`) and test pure logic.
  `packages/infrastructure/test/on-cluster.test.ts` is the pattern: Pulumi mocks and no live
  cloud.

### Integration features

`mise run integration` runs the Gherkin features in `features/` against the deployed dev
environment, as whatever identity ADC holds. A pull request's `dev` job runs them as `deploy-dev`
after its deploy. They never run in `mise run ci`.

- `sign-in.feature` is a browser journey, which `playwright-bdd` runs from
  `test/features/sign-in.steps.ts`. The features of Directus and the syncs are in platform.
- They reach Mailpit through the Kubernetes API's service proxy, and Directus and Authentik at
  their dev hostnames. Nothing test-only is on the Gateway.
- To rerun a branch's features without CI or a deploy, run
  `gh workflow run pull-request.yml --ref <branch> -f integration_only=true`.
- Each scenario names its data with a run ID, so runs never depend on each other.

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

- **Google credentials.** User credentials are for deploys, and ADC is for running tools. No code
  logs in as a super-admin, and no long-lived service account keys.
- **Least-privilege IAM.** New grants are least-privilege.
- **Pulumi resource subclasses.** A resource is a subclass with secure defaults and explicit grant
  methods.
- **ESM imports.** Import paths carry `.js`, except in CommonJS `packages/infrastructure`.
- **No live APIs in unit tests.** Tests mock Pulumi's runtime and `fetch` instead of calling a live
  API.

## Important technical details

- **Node engine.** Packages that declare `engines.node` require `">= 20.8 < 23"`, to match Node.js
  22 in mise and the Docker base image.
- **Directus license activations are limited** (#172). Platform's `docs/backend.md` says what
  spends one. Never change Directus's `PUBLIC_URL`, which the portal and `authentik` derive from
  the domain, without asking the maintainer.

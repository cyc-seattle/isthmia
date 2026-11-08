# AGENTS.md

Guidance for coding agents working in this repository.

Follow `cyc:conventions` (the rules shared by every cyc-seattle repo).

## Project overview

Isthmia is a pnpm monorepo of TypeScript packages that run operations for the CYC Community
Sailing Center. It's being retired: platform deploys Authentik now, and sail-team serves
`cycsail.team`, where the portal was ([cyc-seattle/sail-team#1](https://github.com/cyc-seattle/sail-team/issues/1)).
What's left here is the portal's empty Pulumi project and a copy of Authentik's that doesn't deploy. Directus, its schema, and the Clubspot and Google Workspace syncs live in
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

## Working in this repo

The shared skills and agents live in
[`cyc-seattle/agent-skills`](https://github.com/cyc-seattle/agent-skills). Its README says how to
install them.

- Plans live on GitHub issues. `.plans/` is git-ignored, for local drafts.
- PR titles are conventional commits. PRs merge through the merge queue, which squashes them.
- Never push to `main`.

## Architecture

### Package structure

```
packages/
└── infrastructure/       # Pulumi-based GCP deployment configuration
```

The spreadsheet-to-calendar sync lives in platform's
[`src/syncs/calendar/`](https://github.com/cyc-seattle/platform/tree/main/src/syncs/calendar), and the
break-glass GAM scripts for Google Workspace in [`cyc-seattle/gam`](https://github.com/cyc-seattle/gam).

### Key components

- **infrastructure** — two Pulumi projects under `src/`, described in [Deployment](#deployment).
  `src/cluster.ts` holds what every project shares.

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

| Purpose   | Credential                                | Command                                                                       | Used by          |
| --------- | ----------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| Deploying | **User credentials**                      | `gcloud auth login` (`mise run auth-gcp`)                                     | the `gcloud` CLI |
| Deploying | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (the workplace's `mise run auth-adc`) | `pulumi`         |

Log in with your own account for both. Never log in as a super-admin for development.

### Authentik (`login.cycsail.team`)

Authentik is the sign-in for Directus, by Google or an emailed link. platform deploys it.

## Deployment

Pulumi projects live under `packages/infrastructure/src/`, each with a stack per environment.
`mise run deploy` applies `$PULUMI_STACK`'s projects in order, through `scripts/each-stack`. Both
`dev` and `prod` run on the GKE cluster (#231), each in its own namespace:

- `authentik`: Authentik itself, its database, secrets, and record, and its configuration.
  [platform](https://github.com/cyc-seattle/platform)'s `stacks/authentik` deploys it now, from the
  same state, so `each-stack` skips it here: only one repo may deploy it (#291). Change it in
  platform. The copy here goes when this repo is retired.
- `portal`: empty. The portal is retired, and its program is empty so the deploy deletes what it
  ran. The apex A record it held is retained, and sail-team's stack holds it now. Once both stacks
  are empty, `pulumi stack rm` removes them.

Platform's `backend` stack deploys Directus, its schema, roles, and users, and clubspot-sync and
gsuite-sync, in both environments. Their code moved there from this repo (cyc-seattle/workplace#6).

Mailpit exists only in the `dev` stack. `authentik` reads Directus's OIDC client ID and secret from
platform's `backend` stack in the same environment, through a StackReference.

Prod runs on regular capacity, and dev on Spot. `authentik-server` runs one replica, marked `safe-to-evict: "false"` so Autopilot doesn't move it
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
`@cyc-seattle/platform`'s `WebService` and `Workload`, read the environment's
cluster, Gateway, domain, database, and registry from its outputs, and write their A records into
`infra`'s zone.

Deploys run from Actions (#118). A pull request's push runs only CI. Dev is shared, so only the
merge queue deploys to it, one batch of queued PRs at a time; the batch merges only if it passes (`dev-passed`,
cyc-seattle/platform#80). A push to `main` skips dev, which the queue
already ran on that commit, and runs `prod-preview`, then `prod`, which waits for a maintainer's
approval and is skipped when the preview shows no changes. `each-stack preview` reports each project's changes through
`DEPLOY_CHANGES_FILE`.

### Merge queue

- PRs merge through a batched merge queue. A PR's push runs only CI. The dev deploy runs in the
  queue, one batch at a time, on the one shared dev. This repo has no integration tests.
- Never force-push. To bring a branch up to date, merge `origin/main` into it.
- A queued branch can't be pushed until it's dequeued. Take the PR out of the queue first.
- To try a branch on dev before it's queued, run `gh workflow run pull-request.yml --ref <branch>`.
  Run it only when no other dev run is going (`gh run list --workflow pull-request.yml`).
- When a queue run fails, reproduce the failure locally against dev before you push a fix:
  `PULUMI_STACK=dev mise run preview`.

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

The deploy builds every package and runs Pulumi. It unsets `DOCKER_HOST`, which the docker-build provider
would otherwise record in state (#208).

## Testing

- Tests run with vitest: `mise run test`, or `vitest` for watch mode.
- Test files live at `packages/*/test/**/*.test.ts`, in a top-level `test/` directory per package.
- Mock the external boundary (Pulumi's runtime, `fetch`) and test pure logic.
  `packages/infrastructure/test/on-cluster.test.ts` is the pattern: Pulumi mocks and no live
  cloud.

Authentik's sign-in journeys are platform's now (`features/authentication.feature` there).

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
- Cite an issue instead of recounting its discussion.
- Don't cite a local plan file. A `docs/` reference is fine.
- Test each comment: if you deleted it, would a competent reader still make the same change
  correctly? If yes, delete it.

The same applies to docs:

- **Record the outcome, not the path to it.** Say what to do today, not what failed on the way.
- Use a role name or `<placeholder>` instead of an email address or a numeric account ID.
  Where a command needs a literal, use it once.

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
  22 in mise.
- **Directus license activations are limited** (#172). Platform's `docs/backend.md` says what
  spends one. Never change Directus's `PUBLIC_URL`, which `authentik` derives from
  the domain, without asking the maintainer.

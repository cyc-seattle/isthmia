# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

Isthmia is a pnpm monorepo of TypeScript packages that run operations for the CYC Community
Sailing Center. It integrates with Clubspot (a sailing club management platform) and Google
Workspace, and it deploys automated jobs to Google Cloud Platform.

## Development environment

mise provides the tools: Node.js 22, pnpm, pulumi, and the Google Cloud SDK.

1. Run `mise install` to install the tools.
2. Run `mise run install` to install `node_modules` and generate the Pulumi SDKs.

Run `mise tasks` to list every task. The common ones:

- `mise run ci` — the CI checks: `check`, then `test`
- `mise run build` — install, then build every package with `tsc --build`
- `mise run check` — format check, lint, build, test type checks, and the Dockerfile manifest check
- `mise run format` — fix formatting with Prettier and ESLint
- `mise run test` — run the tests with vitest
- `mise run clean` — delete build output
- `mise run directus-local` — run Directus and Postgres locally with every package's schema applied
- `mise run doctor` — check auth, tooling, and Docker, and fix what it can
- `mise run deploy` — build, then deploy every Pulumi project to GCP (needs authorization)

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
├── commodore/            # Shared CLI utilities (winston logging, commander.js helpers)
├── gsuite/               # Domain-agnostic wrappers around Google Workspace APIs
├── clubspot-sdk/         # TypeScript SDK for TheClubSpot API
├── admin-functions/      # CLI that runs reports, copying Clubspot data into Google Sheets
├── todo-manager/         # CLI tool for syncing Todoist tasks
├── calendar-sync/        # CLI tool and library for syncing Google Calendar with Sheets
├── crm/                  # The canonical domain: schema.yaml and its row types. No jobs.
├── clubspot/             # The Clubspot-shaped schema.yaml and row types. No jobs.
├── directus/             # Infrastructure shared by every sync: the Directus REST client and durable task queue
├── clubspot-sync/        # Cloud Run job that syncs Clubspot data into the CRM's Directus instance
├── gsuite-sync/          # Cloud Run job that syncs the CRM into Google Workspace groups
├── infrastructure/       # Pulumi-based GCP deployment configuration
├── portal/               # Static link portal served at cycsail.team, gated by Google auth
└── substrate/            # The substrate VM's shared front door (Caddy, fronting every app)
```

### Dependency graph

`portal` and `substrate` are apps that `infrastructure` deploys, not libraries. `crm`,
`clubspot`, and `directus` are infrastructure that other packages build on:

- `crm` owns the canonical Directus schema and exports its row types. It has no jobs.
- `clubspot` does the same for the Clubspot-shaped collections. It depends on `crm` for
  `PersonRow`, never the reverse.
- `directus` owns the REST client and the durable task queue that every sync job runs on. It must
  not depend on `crm` or `clubspot`.

```
commodore (base utilities)
    ↑
    ├── clubspot-sdk (Parse SDK wrapper for TheClubSpot API)
    │       ↑
    │       ├── admin-functions (reports, participants, camps, sessions)
    │       └── todo-manager (Todoist integration)
    ├── clubspot-sync (Clubspot <-> crm/clubspot; also depends on clubspot-sdk, directus)
    └── gsuite-sync (Google Workspace <-> crm/clubspot; also depends on directus, gsuite)

gsuite (Google Workspace API wrappers)
    ↑
    ├── admin-functions (uses spreadsheet abstractions)
    ├── calendar-sync (uses Calendar & Spreadsheet clients)
    └── gsuite-sync (uses the Directory and Groups Settings clients)

crm (canonical schema and row types — no dependencies of its own)
clubspot (Clubspot-shaped schema and row types — depends on crm for PersonRow)
directus (Directus REST client and task queue — no dependencies of its own)

infrastructure (deploys admin-functions, clubspot-sync, and gsuite-sync as Cloud Run jobs, plus crm, portal, and substrate)
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

- **commodore** — shared CLI and logging (commander.js, winston). CLI tools depend on it.
- **gsuite** — Google Workspace wrappers: `CalendarClient`, the typed Sheets classes
  (`SpreadsheetClient`, `Spreadsheet`, `Worksheet`, `Table`), and `safeCall`, which rate-limits
  and retries with exponential backoff.
- **clubspot-sdk** — the `Clubspot` class authenticates to TheClubSpot's Parse backend and gives
  typed access to its cloud functions and queries.
- **admin-functions** — reports that copy Clubspot data into Google Sheets. `ReportRunner`
  (`runner.ts`) reads the "Reports" worksheet of a config spreadsheet and runs each enabled row.
  Each `Report` subclass registers in the `reports` map in `reports.ts`. Deployed as the
  `run-reports-job` Cloud Run job.
- **todo-manager** — syncs camp schedules from TheClubSpot to Todoist.
- **calendar-sync** — one-way sync from a spreadsheet to Google Calendar, as a CLI or a library.
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
- **infrastructure** — four Pulumi projects under `src/`, described in [Deployment](#deployment).
  `src/directus/` holds the `Directus*` resource classes that `infrastructure` and `crm` share.
- **portal** — a static site that gives staff and volunteers one bookmark for their tools. Caddy
  serves it, and Authentik gates it.
- **substrate** — one Caddy container that terminates TLS for every app on the substrate VM and
  routes by hostname.

## Authentication

There are two independent auth systems. Do not confuse them.

### Access policy (least privilege)

Only the Workspace super-admin accounts, `master@` and `commander@` (planned), hold root control
of the GCP project and Google Workspace. Use them only for configuration changes: org policy,
project-root IAM, enabling services by hand, and Workspace settings.

Deployers use their own accounts and never a super-admin's credentials. Project `roles/owner` on
`cyc-admin-scripts` is what makes `pulumi up` work. [docs/manual-setup.md](docs/manual-setup.md)
§7 says how to grant it.

The scoped `deployer` role in `packages/infrastructure/src/bootstrap` is for `deploy-runner`, the
service account that GitHub Actions assumes (#118), not for people. A CI workflow must not be able
to grant itself Owner.

### Google Cloud (Sheets, Calendar, deploys)

Google APIs use two credential types for two purposes:

| Purpose                                                                           | Credential                                | Command                                                       | Used by                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Deploying                                                                         | **User credentials**                      | `gcloud auth login` (`mise run auth-gcp`)                     | the `gcloud` CLI                                           |
| Deploying, and running `calendar-sync`, `admin-functions`, `todo-manager` locally | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (`mise run auth-adc`) | `pulumi`, `docker`, and `google-auth-library` in the tools |

Log in with your own account for both. Never log in as a super-admin for development.

The deployed job runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com`, not as your
ADC identity, so a local run may see different sheet access than production.

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

Pulumi state is split into four projects under `packages/infrastructure/src/`. `mise run deploy`
applies all four, in this order:

1. `bootstrap` — identities, and the org's GitHub repos, labels, and security settings
2. `infrastructure` — GCP resources: the Cloud Run jobs, the Directus instance, the substrate VM,
   and the Staff, Coach, and Guardian roles
3. `authentik` — Authentik's sign-in flows, sources, and applications
4. `crm` — the merged Directus schema and permission rules, which need the roles from
   `infrastructure`

`mise run deploy-bootstrap` applies `bootstrap` alone. `mise run deploy` needs:

1. `mise run auth-gcp`, as a deployer
2. project `roles/owner` on `cyc-admin-scripts` (`docs/manual-setup.md` §7)
3. `gh` logged in as a cyc-seattle org owner with the `admin:org` scope
   (`gh auth refresh -h github.com -s admin:org`)

`bootstrap` stores no GitHub secret. Its provider uses `gh auth token`, or `GITHUB_TOKEN` if set.
Deploy and preview refresh `bootstrap` first, so they delete a label added by hand.

The `authentik` project's SDK (`@pulumi/authentik`) is generated into git-ignored `generated/` by
`scripts/gen-sdks`, which `mise run install` runs.

The deploy builds every package, builds Docker images for admin-functions, clubspot-sync, and
gsuite-sync, pushes them to Artifact Registry (us-west1), and runs Pulumi. The image push
authenticates with an OAuth2 token from the running credentials. It uses the current docker
context, so colima, Docker Desktop, or a native daemon all work.

## Testing

- Tests run with vitest: `mise run test`, or `vitest` for watch mode.
- Test files live at `packages/*/test/**/*.test.ts`, in a top-level `test/` directory per package.
- Mock the external SDK boundary (Parse, google-spreadsheet, googleapis) and test pure logic.
  `packages/gsuite/test/spreadsheet.test.ts` is the pattern: hand-rolled mock worksheets and no
  live Google API.

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
- **Least-privilege IAM.** New grants are least-privilege and declared in
  `packages/infrastructure/src/config.ts`.
- **Pulumi resource subclasses.** A resource is a subclass with secure defaults and explicit grant
  methods.
- **ESM imports.** Import paths carry `.js`, except in CommonJS `packages/infrastructure`.
- **SDK boundary.** Tests mock Parse, google-spreadsheet, and googleapis instead of calling a live
  API.
- **Schema changes are serialized.** Two parallel changes to any `packages/*/schema.yaml` conflict.
  Make them one after the other.
- **Dependency graph.** Changes respect the graph above.

## Important technical details

- **Parse SDK.** clubspot-sdk calls `Parse.User.enableUnsafeCurrentUser()`. Parse needs it to keep
  the session for later API calls.
- **Node engine.** Packages that declare `engines.node` require `">= 20.8 < 23"`, to match Node.js
  22 in mise and the Docker base image.
- **Self-links.** Some packages depend on themselves with `link:`, for example
  `"@cyc-seattle/admin-functions": "link:"`.
- **Security overrides.** `pnpm-workspace.yaml` has pnpm overrides for vulnerable transitive
  dependencies.

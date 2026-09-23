# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Isthmia is a collection of TypeScript packages for managing CYC Community Sailing Center operations, built as a pnpm monorepo. The system integrates with Clubspot (a sailing club management platform), Google Workspace, and deploys automated jobs to Google Cloud Platform.

## Development Environment

This project uses a **Nix flake** (with flake-parts) for reproducible development environments. All development commands should be run within the dev shell:

- Enter shell manually: `nix develop`
- Or use direnv to automatically load the environment: `direnv allow`

The dev shell provides:

- Node.js 22 with pnpm (via corepack)
- just (command runner)
- pulumi (infrastructure as code)
- google-cloud-sdk
- gam (Google Workspace admin tool)
- Pre-commit hooks via git-hooks.nix (treefmt for formatting, eslint for linting)

## Common Commands

Use `just` for all common tasks:

- `just` - List all available commands
- `just check` - Run formatting and linting checks
- `just build` - Build all packages using pnpm
- `just clean` - Clean all build artifacts
- `just ci` - Run full CI pipeline (install, build, check, test)
- `just test` - Run tests with vitest
- `just directus-local` - Run Directus and Postgres locally with the CRM schema applied
- `just deploy` - Deploy to GCP (requires authorization)

### Package-specific Commands

Individual packages can be built using standard pnpm workspace commands:

- `pnpm run build` - Build all packages
- `pnpm run -r build` - Build all packages recursively
- `pnpm run clean` - Clean build artifacts

Each package uses TypeScript with `tsc --build` for compilation.

## Workflow

Work happens in **sessions**. A session is one git worktree, one branch, a batch of related
changes, and one pull request at the end. Direct pushes to `main` are not allowed.

Each session gets its own worktree under `.claude/worktrees/`, so several sessions can run at once
in separate terminals without fighting over the working tree. A new worktree needs `direnv allow`
to generate its git hooks, and `just install` for its own `node_modules`.

Never run bare `git stash` in a worktree. The stash stack is shared across all of them.

The human merges every pull request by hand. That merge is the approval. Automation never merges.

Each step of the workflow is a skill in `.claude/skills/`. Run `start-session` to begin. It
composes the rest.

| Skill               | Step                                                       |
| ------------------- | ---------------------------------------------------------- |
| `start-session`     | Create the session branch, then triage and dispatch work   |
| `capture`           | File a GitHub issue                                        |
| `triage`            | Clean up the issue backlog                                 |
| `design`            | Write a design doc to `.claude/plans/` and get it approved |
| `implement`         | Brief and dispatch a sub-agent for one scoped change       |
| `review`            | Review the session diff against isthmia conventions        |
| `end-session`       | Run `just ci`, open the pull request, then review it       |
| `technical-writing` | House style for prose in the repo                          |

The skills that dispatch work use the sub-agents in `.claude/agents/`:

| Agent         | Model  | Tools                        | Role                                    |
| ------------- | ------ | ---------------------------- | --------------------------------------- |
| `designer`    | opus   | read, plus write to `plans/` | Investigate and write the design doc    |
| `implementer` | sonnet | read and write               | Make one scoped change and commit it    |
| `reviewer`    | opus   | read only                    | Report findings, and it cannot fix them |

The agents hold the standing rules — conventions, the test pattern, the review checklist. A skill's
prompt carries only what is specific to the task at hand.

### Three tiers of work

`start-session` sorts each request into a tier and dispatches it. Most work is tier 1 or 2.

1. **Inline** — small, obvious, and local. A typo, a rename, a one-line fix. Done directly in the
   session, then committed.
2. **Delegated** — real work, but the approach is not in doubt. Clarify anything ambiguous, then
   hand it to an `implement` sub-agent.
3. **Designed** — needs a decision, spans packages, or touches infrastructure or auth. Write a
   design doc first with `design`, get it approved, then implement it in steps.

All three tiers land on the same session branch and ship in the same pull request. A GitHub issue
is only needed when work will outlive the session.

### Rules

- Parallelize sub-agents when their file sets are disjoint; serialize anything that shares a
  file or a package, and always serialize any `packages/*/schema.yaml`. Every agent stages explicit
  paths — never `-A` or `.` — since the git index is shared.
- Never deploy or run `just ci` while a writing sub-agent has uncommitted changes on disk —
  both build the working tree, not `HEAD`.
- One commit per task, so a single bad change can be reverted on its own.
- Unrelated problems found mid-task get captured as issues. They never widen the diff.

## Architecture

### Package Structure

The monorepo contains 14 packages organized as follows:

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

### Dependency Graph

`portal` and `substrate` are apps deployed by `infrastructure`, not TypeScript libraries other
packages import. `crm`, `clubspot`, and `directus` are all infrastructure other packages build on,
not apps: `crm` owns the canonical Directus schema and exports its row types with no jobs of its
own; `clubspot` does the same for the Clubspot-shaped collections and depends on `crm` for
`PersonRow`, never the reverse; `directus` owns the REST client and the durable task queue every
sync package's job runs on, and must not depend on `crm` or `clubspot` — it is lower in the graph
than the domain it moves data for.

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

Directus holds the canonical model, and each SaaS product gets a sync package that maps it onto
one or more app domains. The rule that follows: **a canonical collection describes the org, and
anything specific to one product is owned by that product's package.** "Fred is a Parent
Coordinator of the Double-handed program" is canonical, in `crm`. "A Parent Coordinator is a
manager of that program's Google Group" is `gsuite-sync`'s own mapping.

A provider may add a field to a collection it doesn't own: `programs.google_group_id` is a real
column on `programs`, declared in `gsuite-sync`'s `schema.yaml`, not `crm`'s. `gsuite-sync` does
the same for `classes.google_group_id`, even though `classes` belongs to `clubspot`, not `crm` —
the rule cuts by collection ownership, not by which package is canonical. `directus` extends
`people` the same way, for `people.directus_user_id`.

**Every package's `schema.yaml` is merged into one snapshot and applied once** (`mergeSchemas`,
`packages/infrastructure/src/directus/client.ts`), never applied per package in sequence. A
canonical package's own apply would otherwise drop an extension field it doesn't declare, losing
that column's data on every deploy. The merged snapshot carries every field from every package, so
nothing is missing and nothing gets deleted.

### Key Components

**commodore**: Foundation package providing shared CLI and logging utilities. Uses commander-js for CLI parsing and winston for structured logging. Other CLI tools should depend on this for consistent logging and error handling.

**gsuite**: Domain-agnostic wrappers around Google Workspace APIs. Provides:

- `CalendarClient` - Google Calendar API wrapper with CRUD operations for events
- `SpreadsheetClient`, `Spreadsheet`, `Worksheet`, `Table` - Typed abstractions for Google Sheets with rate limiting
- `safeCall` - Rate-limited API call wrapper with exponential backoff retry
- Common utilities like `extractSpreadsheetId`

**clubspot-sdk**: SDK for interacting with TheClubSpot API (a Parse-based backend). The `Clubspot` class handles authentication and provides typed access to cloud functions and queries. Parse SDK is used under the hood with unsafe current user enabled for authentication state.

**admin-functions**: Contains business logic for generating reports about participants, registrations, camps, and sessions. Exports functions that can be invoked as Cloud Run jobs. Uses gsuite package for Google Sheets operations and Google Chat webhooks for notifications. The `runner.ts` module (`ReportRunner`) reads a config spreadsheet ("Reports" worksheet) and runs each enabled row; `reports.ts` defines the abstract `Report` base class and each report subclass registers in the `reports` map. This is the entry point deployed as the `run-reports-job` Cloud Run job.

**todo-manager**: CLI tool that syncs tasks from TheClubSpot (camp schedules) to Todoist. Uses the Doist Todoist API TypeScript client.

**calendar-sync**: CLI tool and library for syncing between Google Calendar and Google Spreadsheet. Can be used as a standalone library or invoked via CLI. Uses gsuite package for Calendar and Spreadsheet operations. Sync is one-way, spreadsheet to calendar, with human-readable spreadsheet column headers.

**crm**: The canonical domain — `schema.yaml` and its row types for the org-wide view of people, contacts, medical profiles, programs, and program roles, no jobs of its own. See `docs/crm-schema.md` for person identity, provenance, and permissions; `schema.yaml` is the source of truth for collections and fields. `infrastructure`'s `crm` project applies the merged schema and the permission rules onto the shared Directus instance the substrate runs. See `packages/crm/README.md`.

**clubspot**: The Clubspot-shaped domain, split out of `crm` because these collections are Clubspot's shape, not the org's — `offerings` (a Camp), `sessions`, `classes`, and every registration and custom-field collection derived from them. `schema.yaml` and row types only, no jobs of its own; depends on `crm` for `PersonRow`. See `packages/clubspot/README.md`.

**directus**: Infrastructure shared by every sync package — the `DirectusClient` REST wrapper and the durable `sync_tasks` queue a job's worker runs on. Owns its own `schema.yaml` (`sync_tasks`, `audit_findings`), merged into the same snapshot as every other package's. Distinct from `packages/infrastructure/src/directus/`, which holds the Pulumi resource classes (`DirectusSchema`, `mergeSchemas`) that apply schemas as GCP infrastructure — this package is what a sync job's own process talks to Directus's REST API with at runtime.

**clubspot-sync**: Cloud Run job that syncs one Clubspot club's camps, schedule, and registrations into `clubspot`'s Directus collections, replacing the spreadsheet-backed reports in admin-functions for that data (#70). Each collection's mapping is a pure plan function with a thin Directus-writing executor, so almost all of it is unit-testable with no Directus and no Parse. See `packages/clubspot-sync/README.md`.

**gsuite-sync**: Cloud Run job that syncs class and program group membership, managers, owners, and settings from `crm` and `clubspot` into Google Groups. Mirrors clubspot-sync's shape — pure plan functions, a thin executor, its own `schema.yaml` for `google_groups` and `google_group_roles`. See `packages/gsuite-sync/README.md`.

**infrastructure**: Pulumi infrastructure-as-code, split into three projects under `src/`: `bootstrap` (identity and access), `infrastructure` (everything resource-scoped — the admin-functions, clubspot-sync, and gsuite-sync Cloud Run jobs, the Directus instance, the substrate VM, and the Staff/Coach/Guardian roles), and `crm` (the merged schema and permission rules for every package's Directus collections, no GCP resources beyond one Secret Manager read). `src/directus/` holds the reusable `Directus*` resource classes shared by the last two.

**portal**: A static site, with no backend, that gives staff and volunteers one bookmark for the tools they use. Served by substrate's Caddy, gated by oauth2-proxy.

**substrate**: The substrate VM's shared front door — one Caddy container terminating TLS for every app on the VM, routed by hostname. Not an app itself; the infrastructure the other apps sit behind.

### Authentication

There are two independent auth systems. Do not confuse them.

#### Access policy (least privilege)

Root-level control of the GCP project and Google Workspace is reserved for the two Workspace
super-admin accounts, `master@cyccommunitysailing.org` and `commander@cyccommunitysailing.org`
(only `master@` exists today; `commander@` is planned as a second break-glass admin so root access
is never held by a single account). Those accounts are the only ones used for **configuration**
changes — org policy, project-root IAM, enabling services by hand, Workspace settings.

Individual deployers hold project-level rights and never a super-admin's
credentials. `gcloud auth login` and ADC both run as your own account; project `roles/owner` on
`cyc-admin-scripts` is what makes `pulumi up` work. See
[docs/manual-setup.md](docs/manual-setup.md) §7 for how that grant is made.

The scoped `deployer` role in `packages/infrastructure/src/bootstrap` is for `deploy-runner`, the
service account GitHub Actions assumes (#118) — not for people. A CI-triggered workflow must not be
able to grant itself Owner; a human deployer isn't meaningfully constrained by that role.

#### Google Cloud (Sheets, Calendar, deploys)

Google APIs use **two different credential types** for **two different purposes**:

| Purpose                                                                                  | Credential                                | Command                                                     | Used by                                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Deploying (`just deploy`)                                                                | **User credentials**                      | `gcloud auth login` (→ `just auth-gcp`)                     | the `gcloud` CLI itself                                                    |
| Deploying and running tools locally (`calendar-sync`, `admin-functions`, `todo-manager`) | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (→ `just auth-adc`) | `pulumi`, `docker`, and the Node.js `google-auth-library` inside the tools |

**Which account:** Use your own account for `gcloud auth login` and `just auth-adc`. Deploy rights come from project `roles/owner` on `cyc-admin-scripts` (`docs/manual-setup.md` §7). Do **not** log in as `master@cyccommunitysailing.org` for development.

> Note: the deployed job runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com`, a different identity from local ADC, so local runs may see different sheet access than production. The legacy `admin-scripts-runner@` service account still exists but is unused; its deletion is tracked in issue #58.

Alternatively, `GOOGLE_APPLICATION_CREDENTIALS` can point at a service-account key file, but a personal login is preferred (no long-lived keys).

#### TheClubSpot (Parse backend)

Separate from Google. The system authenticates to TheClubSpot with a username/password:

1. Locally: supplied via `CLUBSPOT_EMAIL` / `CLUBSPOT_PASSWORD` env vars, or `-u` for the username. The password has no short flag and `--password` is hidden — a secret on argv leaks into `ps` output and shell history (#49). In production: read from GCP Secret Manager secrets `clubspot-username` / `clubspot-password`.
2. Parse SDK is initialized with TheClubSpot's server URL and app ID.
3. User is looked up by email, then logged in with username/password.
4. Parse SDK's "unsafe current user" mode stores the session in memory (required for subsequent authenticated calls; see `Parse SDK Caveat` below).

## Deployment

Pulumi state is split into three projects under `packages/infrastructure/src/`: `bootstrap`
(identities, applied with `just deploy-bootstrap`), `infrastructure` (GCP resources, including the
admin-functions and clubspot-sync Cloud Run jobs), and `crm` (the CRM's Directus schema and
permission rules, which need the roles `infrastructure` creates to already exist).

Deployment to GCP requires:

1. GCP authentication as a deployer: `just auth-gcp` (`gcloud auth login`)
2. Access to the `cyc-admin-scripts` GCP project (project `roles/owner`, granted per `docs/manual-setup.md` §7)
3. Run `just deploy` from repository root, which applies `infrastructure` then `crm`, in that order

Note: the image push no longer needs `gcloud auth configure-docker`. The Pulumi config authenticates the registry push with an OAuth2 access token minted from the running credentials, which also works when building through podman. `just deploy` starts a podman machine and points `DOCKER_HOST` at podman's socket.

The deployment:

- Builds all TypeScript packages
- Creates Docker images for admin-functions, clubspot-sync, and gsuite-sync
- Pushes images to GCP Artifact Registry (us-west1)
- Updates Cloud Run jobs and the CRM's Directus schema via Pulumi

## Testing

- Tests run with **vitest**: `just test` (or `vitest run`, or `vitest` for watch mode).
- Test files live at `packages/*/test/**/*.test.ts` (see `vitest.config.ts` `include`). Note this is a top-level `test/` directory per package, not co-located `.test.ts` files.
- 35 test files and 398 tests, across `admin-functions`, `calendar-sync`, `clubspot-sdk`, `clubspot-sync`, `commodore`, `directus`, `gsuite`, `gsuite-sync`, `infrastructure`, and `portal`. `packages/gsuite/test/spreadsheet.test.ts` is the pattern to follow — hand-rolled mock worksheets, no live Google API. New unit tests should mock the external SDK boundary (Parse, google-spreadsheet, googleapis) and test pure logic.
- `just ci` runs `install → build → check → test`, matching the GitHub Actions `pr.yml` workflow.

## Code Style

- TypeScript with strict type checking (uses `@tsconfig/strictest`)
- ESLint with Prettier integration
- Pre-commit hooks enforce formatting and linting
- All packages use ESM (`"type": "module"`)
- Import paths use `.js` extension (TypeScript ESM convention)

### Comments

Comments explain **why**, not what — the code already says what it does. Keep them to a line or
two. Write one where a reader would otherwise get it wrong: a non-obvious constraint, a surprising
API behavior, a decision that looks arbitrary but isn't.

- Don't narrate the code, restate the diff, or argue the case for the approach you chose over
  another.
- Cite an issue (`#107`) instead of recounting its discussion.
- Don't cite a file in `.claude/plans/` — those docs get deleted once the work lands. A
  `docs/` reference stays fine, same as an issue number.
- Test each comment: if you deleted it, would a competent reader still make the same change
  correctly? If yes, delete it. If not, can it be one line instead of five?

The same applies to docs. Two rules they get wrong most often:

- **Record the outcome, not the path to it.** What to do today. Never what failed on the way,
  what the error said, or what we learned. That belongs in the design doc or the issue.
- **No personal identifiers.** No email addresses, numeric org or account IDs where a role name or
  `<placeholder>` works. Where a command needs a literal, use it once.

Re-read prose before committing it and cut. A first draft is about twice as long as it needs to be.

Note that plenty of existing comments predate this guidance and don't follow it. Trim them when you
have another reason to touch that code — not as a standalone pass.

## Important Technical Details

- **Parse SDK Caveat**: The clubspot-sdk enables `Parse.User.enableUnsafeCurrentUser()` to maintain authentication state. This is required for the Parse SDK to work correctly with subsequent API calls.
- **Engine Constraint**: Packages that declare `engines.node` require `">= 20.8 < 23"`, matching the Node.js 22 that flake.nix and the Docker base image provide.
- **Package Linking**: Some packages have self-references via `link:` in dependencies (e.g., `"@cyc-seattle/admin-functions": "link:"`) - these appear to be for local development
- **Security Overrides**: Root package.json includes pnpm overrides for security vulnerabilities in transitive dependencies

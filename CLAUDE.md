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
- `just ci` - Run full CI pipeline (check + build)
- `just deploy` - Deploy to GCP (requires authorization)

- `just test` - Run tests with vitest

### Package-specific Commands

Individual packages can be built using standard pnpm workspace commands:

- `pnpm run build` - Build all packages
- `pnpm run -r build` - Build all packages recursively
- `pnpm run clean` - Clean build artifacts

Each package uses TypeScript with `tsc --build` for compilation.

## Architecture

### Package Structure

The monorepo contains 7 packages organized as follows:

```
packages/
├── commodore/           # Shared CLI utilities (winston logging, commander.js helpers)
├── gsuite/              # Domain-agnostic wrappers around Google Workspace APIs
├── clubspot-sdk/        # TypeScript SDK for TheClubSpot API
├── admin-functions/     # Business logic for reports and data processing
├── todo-manager/        # CLI tool for syncing Todoist tasks
├── calendar-sync/       # CLI tool and library for syncing Google Calendar with Sheets
└── infrastructure/      # Pulumi-based GCP deployment configuration
```

### Dependency Graph

```
commodore (base utilities)
    ↑
    ├── clubspot-sdk (Parse SDK wrapper for TheClubSpot API)
    │       ↑
    │       ├── admin-functions (reports, participants, camps, sessions)
    │       └── todo-manager (Todoist integration)
    │
gsuite (Google Workspace API wrappers)
    ↑
    ├── admin-functions (uses spreadsheet abstractions)
    └── calendar-sync (uses Calendar & Spreadsheet clients)

infrastructure (deploys admin-functions as Cloud Run jobs)
```

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

**calendar-sync**: CLI tool and library for syncing between Google Calendar and Google Spreadsheet. Can be used as a standalone library or invoked via CLI. Uses gsuite package for Calendar and Spreadsheet operations. Supports one-way sync in either direction with human-readable spreadsheet column headers.

**infrastructure**: Pulumi infrastructure-as-code that deploys admin-functions as containerized Cloud Run jobs on GCP. Creates:

- Docker images in GCP Artifact Registry
- Cloud Run jobs for running reports
- Service accounts with appropriate IAM roles
- Secret Manager secrets for Clubspot credentials

### Authentication

There are two independent auth systems. Do not confuse them.

#### Google Cloud (Sheets, Calendar, deploys)

Google APIs use **two different credential types** for **two different purposes**:

| Purpose                                                                    | Credential                                | Command                                                     | Used by                                              |
| -------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Deploying (`just deploy`)                                                  | **User credentials**                      | `gcloud auth login` (→ `just auth-gcp`)                     | the `gcloud`, `pulumi`, and `docker` CLIs themselves |
| Running tools locally (`calendar-sync`, `admin-functions`, `todo-manager`) | **Application Default Credentials (ADC)** | `gcloud auth application-default login` (→ `just auth-adc`) | the Node.js `google-auth-library` inside the tools   |

**Which account:** Use your own account (`ungood@onetrue.name`) for `gcloud auth login`. It is granted deploy and impersonation rights in `packages/infrastructure/src/config.ts`. Do **not** log in as `master@cyccommunitysailing.org` for development.

**Which service account:** The deployed job runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com`. To make local runs behave exactly like production (same permissions on the same spreadsheets), run tools by **impersonating that service account** via ADC — this is what `just auth-adc` does. This avoids "works locally but not in prod" surprises caused by your personal account having different sheet access.

> Note: the legacy `admin-scripts-runner@` service account still exists in GCP but is no longer used by any recipe. Its deletion is tracked separately in issue #58.

Alternatively, `GOOGLE_APPLICATION_CREDENTIALS` can point at a service-account key file, but impersonation is preferred (no long-lived keys).

#### TheClubSpot (Parse backend)

Separate from Google. The system authenticates to TheClubSpot with a username/password:

1. Locally: supplied via `CLUBSPOT_EMAIL` / `CLUBSPOT_PASSWORD` env vars (or `-u`/`-p` flags — prefer env vars so the password is not visible in `ps`). In production: read from GCP Secret Manager secrets `clubspot-username` / `clubspot-password`.
2. Parse SDK is initialized with TheClubSpot's server URL and app ID.
3. User is looked up by email, then logged in with username/password.
4. Parse SDK's "unsafe current user" mode stores the session in memory (required for subsequent authenticated calls; see `Parse SDK Caveat` below).

## Deployment

Deployment to GCP requires:

1. GCP authentication as a deployer: `just auth-gcp` (`gcloud auth login`)
2. Access to the `cyc-admin-scripts` GCP project (granted in `config.ts`)
3. Run `just deploy` from repository root

Note: the image push no longer needs `gcloud auth configure-docker`. The Pulumi config in `run-reports-job.ts` authenticates the registry push with an OAuth2 access token minted from the running credentials (see the `registries` block), which also works when building through podman. `just deploy` starts a podman machine and points `DOCKER_HOST` at podman's socket.

The deployment:

- Builds all TypeScript packages
- Creates Docker images for admin-functions
- Pushes images to GCP Artifact Registry (us-west1)
- Updates Cloud Run jobs via Pulumi

## Testing

- Tests run with **vitest**: `just test` (or `vitest run`, or `vitest` for watch mode).
- Test files live at `packages/*/test/**/*.test.ts` (see `vitest.config.ts` `include`). Note this is a top-level `test/` directory per package, not co-located `.test.ts` files.
- Current coverage is thin: only `packages/gsuite/test/spreadsheet.test.ts` exists. It uses hand-rolled mock worksheets (no live Google API). New unit tests should follow that pattern — mock the external SDK boundary (Parse, google-spreadsheet, googleapis) and test pure logic.
- `just ci` runs `install → build → check → test`, matching the GitHub Actions `pr.yml` workflow.

## Code Style

- TypeScript with strict type checking (uses `@tsconfig/strictest`)
- ESLint with Prettier integration
- Pre-commit hooks enforce formatting and linting
- All packages use ESM (`"type": "module"`)
- Import paths use `.js` extension (TypeScript ESM convention)

## Important Technical Details

- **Parse SDK Caveat**: The clubspot-sdk enables `Parse.User.enableUnsafeCurrentUser()` to maintain authentication state. This is required for the Parse SDK to work correctly with subsequent API calls.
- **Engine Constraint**: `clubspot-sdk` declares `engines.node: ">= 20.8 < 21"` and `calendar-sync` declares `">= 20.8 < 23"`, but flake.nix (and the Docker base image) provide Node.js 22. The `< 21` bound on clubspot-sdk conflicts with the actual runtime; it is not currently enforced (no `engine-strict` in `.npmrc`) but should be widened to include 22 to avoid confusion.
- **Package Linking**: Some packages have self-references via `link:` in dependencies (e.g., `"@cyc-seattle/admin-functions": "link:"`) - these appear to be for local development
- **Security Overrides**: Root package.json includes pnpm overrides for security vulnerabilities in transitive dependencies

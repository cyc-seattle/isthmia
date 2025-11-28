# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Isthmia is a collection of TypeScript packages for managing CYC Community Sailing Center operations, built as a pnpm monorepo. The system integrates with Clubspot (a sailing club management platform), Google Workspace, and deploys automated jobs to Google Cloud Platform.

## Development Environment

This project uses **devenv** for reproducible development environments. All development commands should be run within the devenv shell:

- Enter shell manually: `devenv shell`
- Or use direnv to automatically load the environment: `direnv allow`

The devenv environment provides:

- Node.js 22 with pnpm
- just (command runner)
- pulumi (infrastructure as code)
- google-cloud-sdk
- Pre-commit hooks (treefmt for formatting, eslint for linting)

## Common Commands

Use `just` for all common tasks:

- `just` - List all available commands
- `just check` - Run formatting and linting checks
- `just build` - Build all packages using pnpm
- `just clean` - Clean all build artifacts
- `just ci` - Run full CI pipeline (check + build)
- `just deploy` - Deploy to GCP (requires authorization)

**Note**: There are currently no tests defined in this project. Running `just test` will fail with a warning.

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

**admin-functions**: Contains business logic for generating reports about participants, registrations, camps, and sessions. Exports functions that can be invoked as Cloud Run jobs. Uses gsuite package for Google Sheets operations and Google Chat webhooks for notifications. The `runner.ts` module provides the execution framework. The `spreadsheets.ts` file re-exports from gsuite for backward compatibility.

**todo-manager**: CLI tool that syncs tasks from TheClubSpot (camp schedules) to Todoist. Uses the Doist Todoist API TypeScript client.

**calendar-sync**: CLI tool and library for syncing between Google Calendar and Google Spreadsheet. Can be used as a standalone library or invoked via CLI. Uses gsuite package for Calendar and Spreadsheet operations. Supports one-way sync in either direction with human-readable spreadsheet column headers.

**infrastructure**: Pulumi infrastructure-as-code that deploys admin-functions as containerized Cloud Run jobs on GCP. Creates:

- Docker images in GCP Artifact Registry
- Cloud Run jobs for running reports
- Service accounts with appropriate IAM roles
- Secret Manager secrets for Clubspot credentials

### Authentication Flow

The system authenticates to TheClubSpot using credentials stored in GCP Secret Manager:

1. Clubspot username/password retrieved from Secret Manager
2. Parse SDK initialized with TheClubSpot's server URL and app ID
3. User lookup by email, then login with username/password
4. Parse SDK's "unsafe current user" mode stores session in memory

## Deployment

Deployment to GCP requires:

1. GCP authentication: `gcloud auth login`
2. Docker authentication: `gcloud auth configure-docker us-west1-docker.pkg.dev`
3. Access to the `cyc-admin-scripts` GCP project
4. Run `just deploy` from repository root

The deployment:

- Builds all TypeScript packages
- Creates Docker images for admin-functions
- Pushes images to GCP Artifact Registry (us-west1)
- Updates Cloud Run jobs via Pulumi

## Code Style

- TypeScript with strict type checking (uses `@tsconfig/strictest`)
- ESLint with Prettier integration
- Pre-commit hooks enforce formatting and linting
- All packages use ESM (`"type": "module"`)
- Import paths use `.js` extension (TypeScript ESM convention)

## Important Technical Details

- **Parse SDK Caveat**: The clubspot-sdk enables `Parse.User.enableUnsafeCurrentUser()` to maintain authentication state. This is required for the Parse SDK to work correctly with subsequent API calls.
- **Engine Constraint**: clubspot-sdk specifies Node.js 20.8 - 20.x in package.json (though devenv.nix provides Node.js 22)
- **Package Linking**: Some packages have self-references via `link:` in dependencies (e.g., `"@cyc-seattle/admin-functions": "link:"`) - these appear to be for local development
- **No Tests**: Currently no test suites are implemented across any packages
- **Security Overrides**: Root package.json includes pnpm overrides for security vulnerabilities in transitive dependencies

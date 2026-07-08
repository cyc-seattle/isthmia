# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

create-config:
    gcloud config configurations create isthmia 2> /dev/null || true

auth-gcp: create-config
    gcloud auth login

auth-adc:
    gcloud auth application-default login \
        --impersonate-service-account  admin-scripts-runner@cyc-admin-scripts.iam.gserviceaccount.com

# Run formatting and linting checks
check:
    treefmt --fail-on-change
    pnpm exec eslint .

# Build all packages
build: install
    pnpm run -r build

# Clean all packages
clean:
    pnpm run -r clean

# Run all tests
test:
    vitest run

# Deploy to GCP (depends on build)
deploy: build
    #!/usr/bin/env bash
    set -euo pipefail
    # pulumi-docker-build talks to a Docker API endpoint; point it at podman.
    podman machine start 2>/dev/null || true
    export DOCKER_HOST="$(./scripts/podman-docker-host)"
    pulumi up --cwd ./packages/infrastructure

# Update flake and npm dependencies
update:
    nix flake update
    pnpm -r update

# Run the ci
ci: install build check test

# Sync the 2026 event calendar
sync-2026:
    calendar-sync --spreadsheet-id 1nY_QmbWIzXdsg_dFZb3teNsIAF5C4uEh3X68FThDnqk --events-worksheet "2026" -vv
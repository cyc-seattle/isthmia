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
        --impersonate-service-account  report-runner@cyc-admin-scripts.iam.gserviceaccount.com

# Print the current gcloud and ADC authentication state (read-only)
auth-status:
    ./scripts/auth-status

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

# Forward localhost:5432 to Cloud SQL's private IP through the substrate VM (Ctrl-C to stop).
# Cloud SQL has no public IP, and the Cloud SQL connectors provide authorization, not connectivity —
# they can't route into the VPC from outside it. `just deploy` opens this itself; run it by hand
# only to poke at the database with psql.
db-tunnel port="5432":
    #!/usr/bin/env bash
    set -euo pipefail
    name=$(gcloud compute instances list --filter="name~substrate" --format="value(name)" | head -1)
    zone=$(gcloud compute instances list --filter="name~substrate" --format="value(zone)" | head -1)
    ip=$(gcloud sql instances list --filter="name~substrate" --format="value(ipAddresses[0].ipAddress)" | head -1)
    echo "tunnelling localhost:{{ port }} -> $ip:5432 via $name ($zone)"
    exec gcloud compute ssh "$name" --zone="$zone" --tunnel-through-iap -- -N -L {{ port }}:"$ip":5432

# Deploy to GCP (depends on build)
deploy: build
    #!/usr/bin/env bash
    set -euo pipefail
    # pulumi-docker-build talks to a Docker API endpoint; point it at podman.
    podman machine start 2>/dev/null || true
    export DOCKER_HOST="$(./scripts/podman-docker-host)"
    # The postgresql provider needs a route to Cloud SQL's private IP (#112). Raise the tunnel for
    # the duration of the apply and tear it down afterwards, so this is automatic rather than a
    # step someone has to remember.
    just db-tunnel &
    tunnel=$!
    trap 'kill $tunnel 2>/dev/null || true' EXIT
    for i in $(seq 1 30); do
        nc -z localhost 5432 2>/dev/null && break
        [ "$i" = 30 ] && { echo "db tunnel never came up" >&2; exit 1; }
        sleep 1
    done
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
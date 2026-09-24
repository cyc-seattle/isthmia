# List available recipes
default:
    @just --list

# Install dependencies
[group('setup')]
install:
    pnpm install

# Prepare a fresh worktree: git hooks, then dependencies (runs automatically on session start)
[group('setup')]
worktree:
    ./scripts/worktree

# Create the isthmia gcloud configuration and point it at the project
[group('auth')]
create-config:
    gcloud config configurations create isthmia 2> /dev/null || true
    gcloud config set project cyc-admin-scripts

# Log in to gcloud as a deployer, in the isthmia configuration
[group('auth')]
auth-gcp: create-config
    gcloud auth login

# Point Application Default Credentials at your own gcloud login
[group('auth')]
auth-adc:
    CLOUDSDK_CONFIG="$(dirname "$GOOGLE_APPLICATION_CREDENTIALS")" gcloud auth application-default login
    CLOUDSDK_CONFIG="$(dirname "$GOOGLE_APPLICATION_CREDENTIALS")" gcloud auth application-default set-quota-project cyc-admin-scripts

# Check auth, tooling, and podman state and print a fix for anything broken
[group('auth')]
doctor:
    ./scripts/doctor

# Format the repo
[group('dev')]
fmt:
    treefmt

# Run formatting, linting, and type checks (each package's src, its tests, and the Dockerfile manifest)
[group('dev')]
check:
    treefmt --fail-on-change
    pnpm exec eslint .
    pnpm run -r build
    for f in packages/*/tsconfig.test.json; do pnpm exec tsc -p "$f" || exit 1; done
    ./scripts/dockerfile-packages

# Build all packages
[group('setup')]
build: install
    pnpm run -r build

# Clean all packages
[group('setup')]
clean:
    pnpm run -r clean

# Run all tests
[group('dev')]
test:
    vitest run

# Bring up local Directus + Postgres containers and apply every package's schema.yaml to them
[group('dev')]
directus-local:
    ./scripts/directus-local up

# Tear down the local Directus + Postgres containers and their volume
[group('dev')]
directus-local-down:
    ./scripts/directus-local down

# Forward localhost:<port> to Cloud SQL through the substrate VM (only needed to poke it with psql)
[group('deploy')]
db-tunnel port="5432":
    ./scripts/db-tunnel {{ port }}

# Deploy to GCP (builds, then applies both Pulumi projects non-interactively, in order)
[group('deploy')]
deploy: doctor build
    ./scripts/deploy

# Show the Pulumi diff `just deploy` would apply to both projects, without applying it
[group('deploy')]
preview: doctor
    ./scripts/preview

# Reconcile Pulumi state with what actually exists in GCP
[group('deploy')]
refresh: doctor
    ./scripts/refresh

# Open an IAP-tunnelled SSH session to the substrate VM
[group('deploy')]
ssh:
    ./scripts/ssh

# Tail a service's container logs on the substrate VM
[group('deploy')]
logs service:
    ./scripts/logs {{ service }}

# Apply the bootstrap stack (identity and access; changes rarely, applied separately)
[group('deploy')]
deploy-bootstrap: doctor
    pulumi up --yes --cwd ./packages/infrastructure/src/bootstrap --stack "${PULUMI_STACK:-prod}"

# Update flake and npm dependencies
[group('setup')]
update:
    nix flake update
    pnpm -r update

# Run the ci
[group('dev')]
ci: install build check test

# Sync the 2026 event calendar
[group('dev')]
sync-2026:
    calendar-sync --spreadsheet-id 1nY_QmbWIzXdsg_dFZb3teNsIAF5C4uEh3X68FThDnqk --events-worksheet "2026" -vv

# Credentials live beside the main checkout, shared by every worktree of this repo. `.envrc`
# sets these too, for tools run outside `just` — but direnv only applies to an interactive
# shell that loaded it, and a recipe run without it would silently read the developer's
# personal gcloud config instead. Setting them here makes `just` authoritative either way.
export CLOUDSDK_CONFIG := shell('dirname "$(git rev-parse --path-format=absolute --git-common-dir)"') / ".gcloud"
export GOOGLE_APPLICATION_CREDENTIALS := CLOUDSDK_CONFIG / "application_default_credentials.json"

# List available recipes
default:
    @just --list

# Install dependencies
[group('setup')]
install:
    pnpm install

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
    gcloud auth application-default login
    gcloud auth application-default set-quota-project cyc-admin-scripts

# Check auth, tooling, and podman state and print a fix for anything broken
[group('auth')]
doctor:
    ./scripts/doctor

# Format the repo
[group('dev')]
fmt:
    treefmt

# Run formatting and linting checks
[group('dev')]
check:
    treefmt --fail-on-change
    pnpm exec eslint .

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

# Forward localhost:<port> to Cloud SQL through the substrate VM (only needed to poke it with psql)
[group('deploy')]
db-tunnel port="5432":
    ./scripts/db-tunnel {{ port }}

# Deploy to GCP (builds, then applies the Pulumi stack non-interactively)
[group('deploy')]
deploy: doctor build
    ./scripts/deploy

# Show the Pulumi diff `just deploy` would apply, without applying it
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
    pulumi up --yes --cwd ./packages/bootstrap --stack "${PULUMI_STACK:-prod}"

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

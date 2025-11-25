# List available recipes
default:
    @just --list

# Run formatting and linting checks
check:
    nix flake check

# Build all packages
build:
    pnpm run -r build

# Clean all packages
clean:
    pnpm run -r clean

# Run all tests (currently no tests are defined)
test:
    @echo "Warning: No tests are currently defined for this project"
    @exit 1

# Deploy to GCP (depends on build)
deploy: build
    pulumi up --cwd ./packages/infrastructure

# Update flake and npm dependencies
update:
    nix flake update
    pnpm -r update

# Run the ci
ci: check build

# Sync the 2026 event calendar
sync-2026:
    calendar-sync --spreadsheet-id 1nY_QmbWIzXdsg_dFZb3teNsIAF5C4uEh3X68FThDnqk --events-worksheet "2026" -vv
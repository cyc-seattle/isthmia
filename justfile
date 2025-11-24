# List available recipes
default:
    @just --list

# Run formatting and linting checks
check:
    nix flake check

# Build all packages
build:
    nix develop --command pnpm run -r build

# Clean all packages
clean:
    nix develop --command pnpm run -r clean

# Run all tests (currently no tests are defined)
test:
    @echo "Warning: No tests are currently defined for this project"
    @exit 1

# Deploy to GCP (depends on build)
deploy: build
    nix develop --command pulumi up --cwd ./packages/infrastructure

# Run the ci
ci: check build

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

# Run all tests
test:
    pnpm run -r test

# Deploy to GCP (depends on build)
deploy: build
    pulumi up --cwd ./packages/infrastructure

# Run the ci
ci: check build test

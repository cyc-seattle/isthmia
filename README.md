# isthmia

[![APLv2][license-badge]][license]
[![Build Status - GitHub Actions][gha-badge]][gha-ci]

A collection of Typescript packages for managing CYC Community Sailing Center.

## Why this name?

[Wikipedia](https://en.wikipedia.org/wiki/Temple_of_Isthmia): "The Temple of Isthmia is an ancient Greek temple on the Isthmus of **Corinth** dedicated to the god **Poseidon** and built in
the Archaic Period."

## Contributing

### Development Tools

This project uses Nix flakes for reproducible development environments. The development environment includes:

- **Node.js 22** and **pnpm** - For TypeScript/JavaScript development
- **just** - Command runner for common tasks
- **prettier** and **eslint** - Code formatting and linting (via treefmt)
- **Pre-commit hooks** - Automatically format and lint code on commit

To get started:

1. Install [Nix](https://nixos.org/download.html) with flakes enabled
2. Run `direnv allow` to automatically activate the development environment (requires [direnv](https://direnv.net/))
3. Or manually enter the dev shell with `nix develop`

Common commands:

- `just` - List available commands
- `just check` - Run formatting and linting checks
- `just build` - Build all packages
- `just ci` - Run full CI checks (build + test)

### Committing

This repository uses a standard Github Pull Request flow. Direct pushes to the `main` branch are not allowed, instead
create changes in feature branches and submit a pull request to merge them to `main`. Pre-commit hooks will automatically
format and lint your changes. You can manually run checks with `just check` before committing.

## Deploying

This project uses [Pulumi](https://www.pulumi.com/) to deploy packages to GCP.

### Authorization

You'll need to be able to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project:

```sh
gcloud auth login
gcloud auth configure-docker us-west1-docker.pkg.dev
```

### Deploy

From the repository root:

```sh
just deploy
```

Or manually from the infrastructure package:

```sh
cd packages/infrastructure
pulumi up
```

## TODO

- Clean up naming of admin-functions/admin-scripts/etc...
- Add the ability to set frequency of reports.

[license-badge]: https://img.shields.io/badge/license-APLv2-blue.svg
[license]: https://github.com/ungood/clubspot-sdk/blob/main/LICENSE
[gha-badge]: https://github.com/cyc-seattle/isthmia/actions/workflows/pr.yml/badge.svg
[gha-ci]: https://github.com/cyc-seattle/isthmia/actions/workflows/pr.yml

# isthmia

[![APLv2][license-badge]][license]
[![Build Status - GitHub Actions][gha-badge]][gha-ci]

A collection of Typescript packages for managing CYC Community Sailing Center.

## Why this name?

[Wikipedia](https://en.wikipedia.org/wiki/Temple_of_Isthmia): "The Temple of Isthmia is an ancient Greek temple on the Isthmus of **Corinth** dedicated to the god **Poseidon** and built in
the Archaic Period."

## Contributing

### Development Tools

This project uses a [Nix flake](https://nixos.wiki/wiki/Flakes) for reproducible development environments. The development environment includes:

- **Node.js 22** and **pnpm** - For TypeScript/JavaScript development
- **just** - Command runner for common tasks
- **prettier** and **eslint** - Code formatting and linting (via treefmt)
- **Pre-commit hooks** - Automatically format and lint code on commit

To get started:

1. Install [Nix](https://nixos.org/download/) with flakes enabled
2. Run `direnv allow` to automatically activate the development environment (requires [direnv](https://direnv.net/))
3. Or manually enter the dev shell with `nix develop`

Common commands:

- `just` - List available commands
- `just check` - Run formatting and linting checks
- `just build` - Build all packages
- `just test` - Run tests
- `just ci` - Run full CI checks (build + test)

### Committing

This repository uses a standard Github Pull Request flow. Direct pushes to the `main` branch are not allowed, instead
create changes in feature branches and submit a pull request to merge them to `main`. Pre-commit hooks will automatically
format and lint your changes. You can manually run checks with `just check` before committing.

## Authentication

Google Cloud access uses **two different credential types for two different purposes**. Don't confuse them.

| Purpose                                                                          | Credential                                | Recipe          | Underlying command                      |
| -------------------------------------------------------------------------------- | ----------------------------------------- | --------------- | --------------------------------------- |
| Deploying (`just deploy`)                                                        | **User credentials**                      | `just auth-gcp` | `gcloud auth login`                     |
| Deploying (`pulumi`, `docker`) and running tools locally (`calendar-sync`, etc.) | **Application Default Credentials (ADC)** | `just auth-adc` | `gcloud auth application-default login` |

Use your own account (e.g. `ungood@onetrue.name`) for both — `just auth-adc` is no longer an impersonated service account, so ADC is your own identity too. Deploy rights come from project `roles/owner` on `cyc-admin-scripts` (see `docs/manual-setup.md` §7).

### Running tools locally (ADC)

The CLI tools (`calendar-sync`, `todo-manager`, `admin-functions`) authenticate to Google via Application Default Credentials, as does `pulumi` when deploying. Run:

```sh
just auth-adc
```

This runs `gcloud auth application-default login` as your own user, so local runs use the same account as `gcloud auth login`. This differs from the deployed Cloud Run job, which runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com` — local runs may see different sheet access than production as a result.

Alternatively, `GOOGLE_APPLICATION_CREDENTIALS` can point at a service-account key file, but a personal login is preferred (no long-lived keys).

### Checking your auth state

Before a deploy, check that gcloud, ADC, and podman are all in a working state:

```sh
just doctor
```

This prints your active gcloud account, configuration, project, and ADC identity, then runs a
series of checks — PATH, gcloud login, ADC validity, project and Pulumi access, and podman — and
prints the specific fix command for anything that's broken. It exits non-zero if any check fails.
`just deploy` and `just preview` run it first, so a bad credential is caught immediately instead of
partway through an apply.

For more information, see [Google Cloud Authentication Documentation](https://cloud.google.com/docs/authentication/getting-started).

## Deploying

This project uses [Pulumi](https://www.pulumi.com/) to deploy packages to GCP.

### Authorization

You'll need to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project:

```sh
just auth-gcp
```

This runs `gcloud auth login` with your user credentials. The registry push no longer needs `gcloud auth configure-docker` — the Pulumi config authenticates the push with an OAuth2 access token minted from your running credentials.

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

### Manual setup steps

Some setup can't be infrastructure-as-code — OAuth clients and consent screens, Workspace
domain-wide delegation, DNS registrar delegation, and secret _values_. Every such out-of-band step
is recorded in **[docs/manual-setup.md](docs/manual-setup.md)**.

## TODO

- Clean up naming of admin-functions/admin-scripts/etc...
- Add the ability to set frequency of reports.

[license-badge]: https://img.shields.io/badge/license-APLv2-blue.svg
[license]: https://github.com/ungood/clubspot-sdk/blob/main/LICENSE
[gha-badge]: https://github.com/cyc-seattle/isthmia/actions/workflows/pr.yml/badge.svg
[gha-ci]: https://github.com/cyc-seattle/isthmia/actions/workflows/pr.yml

# isthmia

[![APLv2][license-badge]][license]
[![Build Status - GitHub Actions][gha-badge]][gha-ci]

A collection of Typescript packages for managing CYC Community Sailing Center.

## Why this name?

[Wikipedia](https://en.wikipedia.org/wiki/Temple_of_Isthmia): "The Temple of Isthmia is an ancient Greek temple on the Isthmus of **Corinth** dedicated to the god **Poseidon** and built in
the Archaic Period."

## Contributing

Read the org's [CONTRIBUTING](https://github.com/cyc-seattle/.github/blob/main/CONTRIBUTING.md) guide first.

### Setup

1. Install [mise](https://mise.jdx.dev/) and [Docker](https://www.docker.com/).
2. Activate mise in your shell, by adding `eval "$(mise activate zsh)"` (or `bash`) to your shell rc. See [Getting started](https://mise.jdx.dev/getting-started.html). Without it, `GOOGLE_APPLICATION_CREDENTIALS` and `node_modules/.bin` exist only inside `mise run` and `mise exec`, so the CLI tools and bare `vitest` fail.
3. Run `mise trust`. `gam/` needs its own `mise trust`.
4. Run `mise run install`. It installs the tools, `node_modules`, and the Pulumi SDKs, and installs the lefthook git hooks.

In an existing clone, delete the leftover `.direnv/` and `.pre-commit-config.yaml`, which git no longer ignores. `lefthook install` can also refuse because the old git-hooks.nix set `core.hooksPath`. Run `git config --unset-all core.hooksPath` once, then run `mise run install` again.

### Common tasks

Run `mise tasks` to list every task. The common ones:

- `mise run check` - Run the format check, lint, build, and type checks
- `mise run format` - Fix formatting and lint
- `mise run build` - Build all packages
- `mise run test` - Run tests
- `mise run ci` - Run the full CI checks (`check`, then `test`)

### Committing

This repository uses a standard Github Pull Request flow. Direct pushes to the `main` branch are not allowed, instead
create changes in feature branches and submit a pull request to merge them to `main`. The lefthook pre-commit hook checks
the format and lint of your staged files. You can manually run checks with `mise run check` before committing.

## Authentication

Google Cloud access uses **two different credential types for two different purposes**. Don't confuse them.

| Purpose                                                                          | Credential                                | Task                | Underlying command                      |
| -------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- | --------------------------------------- |
| Deploying (`mise run deploy`)                                                    | **User credentials**                      | `mise run auth-gcp` | `gcloud auth login`                     |
| Deploying (`pulumi`, `docker`) and running tools locally (`calendar-sync`, etc.) | **Application Default Credentials (ADC)** | `mise run auth-adc` | `gcloud auth application-default login` |

Use your own account for both. Deploy rights come from project `roles/owner` on `cyc-admin-scripts` (`docs/manual-setup.md` §7).

### Running tools locally (ADC)

The CLI tools (`calendar-sync`, `todo-manager`, `admin-functions`) authenticate to Google via Application Default Credentials, as does `pulumi` when deploying. Run:

```sh
mise run auth-adc
```

This runs `gcloud auth application-default login` as your own account, the same one as `gcloud auth login`. The deployed Cloud Run job instead runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com`, so local runs may see different sheet access than production.

Alternatively, `GOOGLE_APPLICATION_CREDENTIALS` can point at a service-account key file, but a personal login is preferred (no long-lived keys).

### Checking your auth state

Before a deploy, verify gcloud, ADC, and docker are working:

```sh
mise run doctor
```

It prints your credentials, checks project and Pulumi access, and suggests a fix for anything
broken. It exits non-zero on failure. `mise run deploy` and `mise run preview` run it first.

For more information, see [Google Cloud Authentication Documentation](https://cloud.google.com/docs/authentication/getting-started).

## Deploying

This project uses [Pulumi](https://www.pulumi.com/) to deploy packages to GCP.

### Authorization

You'll need to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project:

```sh
mise run auth-gcp
```

This runs `gcloud auth login` with your user credentials. The registry push no longer needs `gcloud auth configure-docker` — the Pulumi config authenticates the push with an OAuth2 access token minted from your running credentials.

### Deploy

From the repository root:

```sh
mise run deploy
```

Or manually from the infrastructure package:

```sh
cd packages/infrastructure/src/infrastructure
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
[gha-badge]: https://github.com/cyc-seattle/isthmia/actions/workflows/pull-request.yml/badge.svg
[gha-ci]: https://github.com/cyc-seattle/isthmia/actions/workflows/pull-request.yml

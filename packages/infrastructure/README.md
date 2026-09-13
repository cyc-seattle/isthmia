# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

Code lives under `src/`, organized by Pulumi stack: `src/infrastructure/` (everything
resource-scoped), `src/people-hub/` (the people hub app's schema and permission rules), and
`src/bootstrap/` (identity and access, applied separately — see below). `src/directus/` holds the
reusable `Directus*` resource classes shared by `infrastructure` and `people-hub`; other shared
modules live directly in `src/`. Each stack directory has its own minimal `package.json` marker,
since Pulumi's nodejs language host resolves a program's entry point from the nearest one.

## Authorization

You'll need to be able to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project.

```sh
gcloud auth login
```

## Deploy

```sh
just deploy
```

The `prod` stack must exist for `people-hub` first. Create it once, team-wide:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/src/people-hub
```

`Pulumi.prod.yaml` is already in the repo and sets `gcp:project` for the new stack.

## Bootstrap

`src/bootstrap` is a second Pulumi project that owns identity and access for the
`cyc-admin-scripts` GCP project: the `deploy-runner` service account CI impersonates to deploy, and
the project-level IAM bound to it. It changes rarely and is applied separately from the rest of
this package, which owns everything resource-scoped. Unrelated to
`src/infrastructure/substrate-bootstrap.ts`, which builds the VM's cloud-init.

See `.claude/plans/deployer-access.md` for the design.

### Deploy

```sh
just deploy-bootstrap
```

The `prod` stack must exist in Pulumi Cloud first. Create it once, team-wide:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/src/bootstrap
```

`Pulumi.prod.yaml` is already in the repo and sets `gcp:project` for the new stack.

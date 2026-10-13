# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

Code lives under `src/`, organized by Pulumi stack: `src/infrastructure/` (everything
resource-scoped), `src/crm/` (the CRM app's schema and permission rules), and
`src/bootstrap/` (identity and the org's GitHub repos, see below). `src/directus/` holds the
reusable `Directus*` resource classes shared by `infrastructure` and `crm`; other shared
modules live directly in `src/`. Each stack directory has its own minimal `package.json` marker,
since Pulumi's nodejs language host resolves a program's entry point from the nearest one.

## Authorization

You'll need to be able to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project.

```sh
gcloud auth login
```

## Deploy

```sh
mise run deploy
```

The `prod` stack must exist for `crm` first. Create it once, team-wide:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/src/crm
```

`Pulumi.prod.yaml` is already in the repo and holds the new stack's config.

## Bootstrap

`src/bootstrap` is a second Pulumi project. It owns identity and access for the `cyc-admin-scripts`
GCP project: the `deploy-runner` service account CI impersonates to deploy, and the project-level
IAM bound to it. It also owns the org's GitHub repos, labels, and security settings
(`src/bootstrap/github.ts`). To add a repo, add a `StandardRepository` there. `mise run deploy` applies
it first, before the project that owns everything resource-scoped. Unrelated to
`src/infrastructure/substrate-bootstrap.ts`, which builds the VM's cloud-init.

No GitHub secret is stored. The provider uses `gh auth token`, or `GITHUB_TOKEN` if set, and the
private-vulnerability-reporting commands run `gh api`, so run `gh auth login` as a cyc-seattle org
owner first. Bootstrap also manages an org-level Actions setting, so the login needs the `admin:org`
scope: `gh auth refresh -h github.com -s admin:org`. Deploys and previews refresh the stack first, which deletes any label added by hand.

See [AGENTS.md](../../AGENTS.md) → Access policy for why `deploy-runner` gets a scoped role instead of Owner.

### Deploy

`mise run deploy` applies it. To apply only this project:

```sh
mise run deploy-bootstrap
```

The `prod` stack must exist in Pulumi Cloud first. Create it once, team-wide:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/src/bootstrap
```

`Pulumi.prod.yaml` is already in the repo and holds the new stack's config.

# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

Code lives under `src/`, organized by Pulumi stack: `src/infrastructure/` (everything
resource-scoped), `src/authentik/` (sign-in), and `src/crm/` (the CRM app's schema and permission
rules). The identities and the org's GitHub settings live in [platform](https://github.com/cyc-seattle/platform)'s `bootstrap` stack.
`src/directus/` holds the
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

## State

Each environment's state lives in its own bucket, `gs://cyc-admin-scripts-pulumi-<stack>`, and its
secrets are encrypted with the `state-<stack>` KMS key. platform's `bootstrap` stack creates both.
`mise.toml` picks the bucket from `PULUMI_STACK`, which defaults to `prod`, so stack names are
`organization/<project>/<stack>`. Each `Pulumi.<stack>.yaml` holds the stack's config and its
secrets provider.

To create a new stack:

```sh
pulumi stack init organization/<project>/<stack> --cwd ./packages/infrastructure/src/<project> \
  --secrets-provider gcpkms://projects/cyc-admin-scripts/locations/us-west1/keyRings/pulumi/cryptoKeys/state-<stack>
```

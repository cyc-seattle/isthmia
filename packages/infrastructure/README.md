# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

Code lives under `src/`, one directory per Pulumi project:

- `authentik`: Authentik itself and its configuration
- `crm`: Directus, its roles and users, and the CRM's schema and permission rules
- `portal`: Caddy and the static site
- `clubspot-sync`, `gsuite-sync`: the CronJobs, and in dev, the fakes

The identities and the org's GitHub settings live in [platform](https://github.com/cyc-seattle/platform)'s
`bootstrap` stack. `src/directus/` holds the reusable `Directus*` resource classes and the CRM's
roles, shared by `authentik` and `crm`. `src/cluster.ts` holds what every project shares: the
platform outputs and cluster provider, databases, Secrets, and images. `src/cloud.ts` holds the A
records and prod's databases, in platform's `cloud` stack. Each project
directory has its own minimal `package.json` marker, since Pulumi's nodejs language host resolves a
program's entry point from the nearest one.

## The cluster

Every project runs its workloads on the cluster, in its environment's namespace. Mailpit and the
fakes exist only in the `dev` stack.

- In dev, platform's `cloud` stack creates each database and its user, and keeps the password in
  Secret Manager as `dev-db-<name>-password`, which the deploy reads. In prod, each project creates
  its own through the Cloud SQL Admin API. Either way, each database's Secret, `<database>-db`,
  holds its host, credentials, and connection URI. `mise run db-shell <database>`
  opens `psql` from a throwaway pod in the namespace.
- Generated values are `random` resources, written to Kubernetes Secrets. Hand-set values stay in
  Secret Manager and are read at deploy time; dev's have a `dev-` prefix.
- Images are tagged with the commit SHA. Only the dev deploy builds them, and prod runs the image dev
  built for its commit.
- Projects read each other through StackReferences in the same environment: `crm` reads
  `authentik`'s `directusOidcClientSecret`, and the syncs read `crm`'s `clubspotSyncToken` and
  `gsuiteSyncToken`.

## Authorization

You'll need to be able to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project.

```sh
gcloud auth login
```

## Deploy

```sh
mise run preview   # what would change
mise run deploy
```

Both run `scripts/each-stack`, which picks the projects and their order from `PULUMI_STACK`
(default `prod`). A pull request's Actions run deploys `dev`. A push to `main` deploys `dev`, previews
`prod`, and then deploys `prod` once a maintainer approves. To preview dev from a laptop, run
`PULUMI_STACK=dev mise run preview`.

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

# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

Code lives under `src/`, one directory per Pulumi project:

- `infrastructure`: the substrate VM and everything prod runs on it
- `authentik`: Authentik's configuration, and on the cluster, Authentik itself
- `crm`: the CRM's schema and permission rules, and on the cluster, Directus and its roles and users
- `portal`, `clubspot-sync`, `gsuite-sync`: cluster-only, so far in dev only

The identities and the org's GitHub settings live in [platform](https://github.com/cyc-seattle/platform)'s
`bootstrap` stack. `src/directus/` holds the reusable `Directus*` resource classes and the CRM's
roles, shared by `infrastructure` and `crm`. `src/cluster.ts` holds what every on-cluster project
shares: the platform outputs and cluster provider, databases, Secrets, and images. Each project
directory has its own minimal `package.json` marker, since Pulumi's nodejs language host resolves a
program's entry point from the nearest one.

## The cluster

A project runs its workloads on the cluster only when its stack sets `<project>:onCluster: true`.
Every `Pulumi.dev.yaml` sets it. A prod stack sets it in that project's move (#231), so until then
prod runs on the VM as before. Mailpit and the fakes exist only in the `dev` stack.

On the cluster:

- Databases and users come from the Cloud SQL Admin API, on the environment's instance. Each
  database's Secret, `<database>-db`, holds its host and credentials. `mise run db-shell <database>`
  opens `psql` from a throwaway pod in the namespace.
- Generated values are `random` resources, written to Kubernetes Secrets. Hand-set values stay in
  Secret Manager and are read at deploy time; dev's have a `dev-` prefix.
- Images are tagged with the commit SHA. Only the dev deploy builds them.
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
(default `prod`). A pull request's Actions run deploys `dev`. To preview dev from a laptop, run
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

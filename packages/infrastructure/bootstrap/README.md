# Isthmia Bootstrap

A second Pulumi project that owns identity and access for the `cyc-admin-scripts` GCP project: the
`deploy-runner` service account CI impersonates to deploy, and the project-level IAM bound to it.
It changes rarely and is applied separately from the rest of `packages/infrastructure`, which owns
everything resource-scoped.

See `.claude/plans/deployer-access.md` for the design. Unrelated to `../src/substrate-bootstrap.ts`,
which builds the VM's cloud-init.

`package.json` here is a minimal marker — Pulumi's nodejs host needs one to find this program's
entry point separately from the parent package's.

## Deploy

```sh
just deploy-bootstrap
```

The `prod` stack must exist in Pulumi Cloud first. Create it once, team-wide:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/bootstrap
```

`Pulumi.prod.yaml` is already in the repo and sets `gcp:project` for the new stack.

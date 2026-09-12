# Isthmia Bootstrap

A second Pulumi project that owns identity and access for the `cyc-admin-scripts` GCP project: the
`deploy-runner` service account CI impersonates to deploy, and the project-level IAM bound to it.
It changes rarely and is applied separately from the rest of `packages/infrastructure`, which owns
everything resource-scoped.

See `.claude/plans/deployer-access.md` for the design.

`package.json` here is a minimal marker with no dependencies — Pulumi's nodejs language host needs
a `package.json` to resolve this Pulumi program's entry point instead of the parent package's.

## Deploy

```sh
just deploy-bootstrap
```

### First apply only

The `prod` stack has to exist in Pulumi Cloud before that recipe works, or it fails with
`error: no stack named 'prod' found`. Create it once:

```sh
pulumi stack init prod --cwd ./packages/infrastructure/bootstrap
```

`Pulumi.prod.yaml` is in the repo, so the new stack picks up `gcp:project` with no further
configuration. This is a one-time action for the whole team — the stack lives in Pulumi Cloud, not
on your machine.

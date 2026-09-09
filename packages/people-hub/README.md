# @cyc-seattle/people-hub

The CRM / people hub app: Layer 2 of `docs/architecture.md`. **Directus is the engine, not the
app** — this package is the app's own schema and permission model, deployed onto the shared
Directus instance the substrate runs (see `@cyc-seattle/substrate`). A second Directus-backed app
later would be its own package alongside this one, sharing the same Directus infra.

## Contents

- **`schema.yaml`** — the Directus schema snapshot (collections/fields/relations) for this app's
  data model. See [docs/people-hub-schema.md](../../docs/people-hub-schema.md) for the design this
  implements. Generated with `directus schema snapshot` against a real instance, not hand-written —
  regenerate the same way if the schema changes.
- The **Staff/Coach/Guardian roles/policies**, and applying `schema.yaml` itself, aren't a separate
  manual step — both are Pulumi-managed resources in `infrastructure/src/people-hub.ts`
  (`DirectusSchema`, `DirectusRole`, `DirectusUser` — see `infrastructure/src/directus.ts` for the
  reusable resource types themselves, built directly on Directus's REST API rather than its CLI).

## Applying the schema

`pulumi up`. That's it — see [docs/manual-setup.md](../../docs/manual-setup.md) §6 for the one
remaining manual step first (a Postgres `GRANT` that needs a live SQL connection Pulumi can't make)
and the full sequencing on a fresh deploy.

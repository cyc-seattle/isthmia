# @cyc-seattle/crm

The CRM app: Layer 2 of `docs/architecture.md`. **Directus is the engine, not the
app** — this package is the app's own schema and permission model, deployed onto the shared
Directus instance the substrate runs (see `@cyc-seattle/substrate`). A second Directus-backed app
later would be its own package alongside this one, sharing the same Directus infra.

## Contents

- **`schema.yaml`** — the Directus schema snapshot (collections/fields/relations) for this app's
  data model. See [docs/crm-schema.md](../../docs/crm-schema.md) for the design this
  implements. Generated with `directus schema snapshot` against a real instance, not hand-written —
  regenerate the same way if the schema changes.
- The **Staff/Coach/Guardian roles and the one user** are identity, not app data, and live in the
  `infrastructure` project (`infrastructure/src/infrastructure/directus-roles.ts`). Applying
  `schema.yaml` and this app's permission rules is Pulumi-managed by its own project,
  `infrastructure/src/crm/` (`DirectusSchema`, `DirectusPermissionRule`). Both projects build
  on the reusable resource types in `infrastructure/src/directus/`, built directly on Directus's
  REST API rather than its CLI.

## Applying the schema

`just deploy` applies the `infrastructure` project first, then `crm` — the roles and policy
IDs the schema's rules attach to must exist first. See
[docs/manual-setup.md](../../docs/manual-setup.md) §6 for Directus setup that isn't Pulumi-managed.

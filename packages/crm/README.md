# @cyc-seattle/crm

The CRM app: Layer 2 of `docs/architecture.md`. **Directus is the engine, not the
app** — this package is the app's own schema and permission model, deployed onto the shared
Directus instance the substrate runs (see `@cyc-seattle/substrate`). A second Directus-backed app
later would be its own package alongside this one, sharing the same Directus infra.

## Contents

- **`schema.yaml`** — the normative, checked-in definition of this app's collections, fields, and
  relations (see [docs/crm-schema.md](../../docs/crm-schema.md) for the design it implements).
  Edited directly; Pulumi's `crm` project applies it to the live instance. Verify a change against
  `just directus-local` before deploying.
- **`src/`** — the TypeScript row types for the collections `schema.yaml` declares, exported for
  anything that reads or writes the CRM. They live here rather than in a consumer because a sync
  maps between two schemas rather than defining one; `packages/clubspot` imports `PersonRow`, and
  `packages/clubspot-sync` and `packages/gsuite-sync` import from both `crm` and `clubspot`.
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

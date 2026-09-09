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
- The **Staff/Coach/Guardian roles and policies** aren't in this package — they're Pulumi-managed
  resources in `infrastructure/src/people-hub.ts`, since Directus's schema snapshot format doesn't
  cover roles/permissions. See that file, and `infrastructure/src/directus.ts` for the reusable
  Directus-role Pulumi resource type it's built on.

## Applying the schema

See [docs/manual-setup.md](../../docs/manual-setup.md) §6 for the full one-time setup (OAuth,
database role, schema apply, restart gotcha). Short version:

```sh
docker cp schema.yaml <directus-container>:/directus/uploads/schema.yaml
docker exec <directus-container> npx directus schema apply /directus/uploads/schema.yaml -y
docker restart <directus-container>   # schema apply doesn't invalidate the running server's cache
```

Then `pulumi up` creates/updates the Staff/Coach/Guardian roles (see `people-hub.ts`).

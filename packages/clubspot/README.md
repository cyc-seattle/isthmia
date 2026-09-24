# @cyc-seattle/clubspot

The Clubspot-shaped Directus schema: `camps` (a Clubspot Camp), `sessions`, `classes`, and
every registration and custom-field collection derived from them — a Directus schema and its row
types, deployed on the shared substrate alongside `@cyc-seattle/crm`. No jobs of its own.

Split out of `crm` because these collections are Clubspot's shape, not the org's: they would not
survive Clubspot being replaced. `crm` keeps `people`, `contacts`, `medical_profiles`, `programs`,
and the program-role tables — the collections that would.

## Contents

- **`schema.yaml`** — the normative, checked-in definition of this package's collections, fields,
  and relations. Edited directly; Pulumi's `crm` project applies the merged snapshot of every
  package's schema to the live instance. Verify a change against `just directus-local` before
  deploying.
- **`src/`** — the TypeScript row types for the collections `schema.yaml` declares, exported for
  `clubspot-sync` and `gsuite-sync`, both of which read or write this data.

This package depends on `@cyc-seattle/crm` for `PersonRow`; `crm` has no dependencies of its own,
and this package is never imported by it.

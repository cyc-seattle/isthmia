# Move the people hub into its own Pulumi project

Issue [#108](https://github.com/cyc-seattle/isthmia/issues/108), app-project tier. The `bootstrap`
tier landed in #119 (`04a5013c`); the issue's directory table is stale.

## Context

There are already two Pulumi projects, both inside `packages/infrastructure`:
`src/bootstrap/` and `src/infrastructure/`, each with its own `Pulumi.yaml`, `Pulumi.prod.yaml`, and
a stub `package.json` marking the program entry point (`packages/infrastructure/README.md:5`).
`infrastructure` reads identities back over a `StackReference` (`src/infrastructure/identities.ts:6`).

What remains is the app tier. `src/infrastructure/people-hub.ts` declares the people hub's Directus
schema (`:62`), three roles (`:72`, `:88`, `:116`), and one user (`:154`) inside the same program as
Cloud SQL, the VM, DNS, and the static IP. Every schema edit previews all of it.

Three findings that shape the design:

- **`people-hub` does not depend on the rest of #107.** The part it needed already shipped:
  `src/infrastructure/substrate-apply.ts:25` reconciles the VM's compose stack on every `pulumi up`,
  and `people-hub.ts:65` depends on it. Everything people-hub does is HTTP against an
  already-running Directus (`directus-client.ts`). It ships no container and no compose project, so
  #107's remaining work — per-app compose projects, `packages/directus/` — blocks FreeScout and
  Listmonk, not this. Across a project boundary the `substrateApply` edge becomes apply order
  (infrastructure first), with `waitForReachable` (`directus-client.ts:27`) still the safety net.
- **#109 shipped.** `applySchema` merges the app's snapshot onto the live one and refuses any
  collection-level delete (`directus-client.ts:203-218`). A second app schema is safe, and the
  `DirectusSchema` create is idempotent — which is what makes the migration below cheap.
- **`DirectusRole.update` clears every permission row under its policy**
  (`directus.ts:254` → `clearPermissions`, `directus.ts:203`). If roles stay in `infrastructure`
  while an app contributes rules, an `infrastructure` apply silently deletes the app's rules. This
  is the same shape as the `gcp.serviceaccount.IAMMember` clobber recorded in
  `.claude/plans/deployer-access.md:299` — two stacks writing one policy. It must be removed, not
  worked around.

## Approach

### Where the project lives

`packages/infrastructure/src/people-hub/`, beside the other two projects, following the precedent
#119 set. The program contains no GCP resources — one Secret Manager read and Directus HTTP calls —
which is the property #108 actually wants; the directory it sits in is cosmetic.

`packages/people-hub/` stays the app's own home (`schema.yaml`, README). Putting the Pulumi project
there instead needs the `Directus*` resource classes to leave `packages/infrastructure`, since
`packages/people-hub` cannot depend on the infrastructure package without inverting the dependency
graph. The right destination for them is the `packages/directus/` package #107's review already
decided to create for Directus's compose artifacts. That is a real refactor and belongs with #107,
not here. See Open questions.

### Shared Directus module

`src/infrastructure/directus.ts` mixes two things: GCP/Postgres resources created at module scope
(`:32-90`) and the reusable dynamic resource classes (`:115-377`). A second program importing the
classes would create a duplicate copy of the secrets, the Postgres role, and the DNS record.

Split it. The classes and `directus-client.ts` move to `src/directus/` — shared, project-neutral,
no module-scope resources — matching how `src/config.ts` and `src/services.ts` are already shared
between the two existing projects. `src/infrastructure/directus.ts` keeps the instance: secrets,
`directusDbUser`, `directusDatabase`, `directusDnsRecord`.

### Permission rules become their own resource

Confirmed against the code: yes, the split needs this. Rules are inputs to `DirectusRole` today
(`directus.ts:180`, consumed at `people-hub.ts:81`, `:98`, `:128`), and permissions attach to the
**policy**, not the role (`directus.ts:194` posts `policy: policyId`) — so the key is
(policyId, collection, action), not roleId.

- New `DirectusPermissionRule` dynamic resource. `create` POSTs `/permissions` and stores the
  returned row id as the resource id; `delete` deletes that row and nothing else.
- **`create` must adopt an existing row** matching (policy, collection, action) instead of posting a
  second one. The rows the old `DirectusRole` provider created outlive it — dropping
  `permissionRules` does not delete them, because deleting `clearPermissions` is the point — so a
  create that always POSTs would duplicate all 53 on the first apply. Same idempotence that
  `DirectusSchema.create` already has post-#109.
- `DirectusRole` drops `permissionRules`, and `clearPermissions` is deleted with it. A role then
  owns its policy's identity and `app_access`; whoever declares a rule owns that row. That is what
  makes the cross-stack clobber impossible rather than merely unlikely.
- 53 rules result: Staff 11 collections × 4 actions, Coach 5, Guardian 4. Names are derived from
  `collectionsInSchema` (`directus-client.ts:125`), as today.

**Roles and users stay in `infrastructure`**, per the issue — they are identity, and #65 will give
them meaning beyond one app. The `Guardian` judgment call gets cheaper under this split: once the
filters (`people-hub.ts:108-145`) move to the app with the rules, the role left behind carries no
people-hub detail at all. Keep the Pulumi resource names (`people-hub-staff`, …) unchanged — a
rename replaces the role, which drops its policy and every user assignment.

### Cross-project plumbing

`src/people-hub/refs.ts`, following `identities.ts:6-8`: one `StackReference`, stack name from
config with a default, typed accessors. Four outputs, not the issue's speculative 8-12 — they are
all the app needs:

| Output                                               | Used for              |
| ---------------------------------------------------- | --------------------- |
| `directusBaseUrl`                                    | every API call        |
| `staffPolicyId`, `coachPolicyId`, `guardianPolicyId` | the rules it attaches |

The admin password stays a direct Secret Manager read by literal secret name
(`people-hub.ts:42`), never a stack output. Its `dependsOn: directusAdminBootstrapPassword.version`
disappears: the secret exists before the app project ever runs.

No new IAM. The deployer reads that secret today through project Owner, and `deploy-runner` through
`roles/secretmanager.admin`; `config.ts:15` is untouched.

### Migration

Only `people-hub-schema` and the 53 permission rules change owner. The roles and the user stay in
the `infrastructure` stack — a file move inside one program does not change a URN.

No `pulumi state move` and no state surgery. `DirectusSchema.delete` is already a deliberate no-op
(`src/directus/resources.ts:66`) and its `create` is idempotent post-#109, so dropping it from `infrastructure`
and declaring it in `people-hub` costs one no-op delete and one re-apply against an already-synced
instance. `retainOnDelete` is unnecessary for the same reason — the hazard
`.claude/plans/deployer-access.md:306` records is a real cloud delete, which this is not. The apply
order from that lesson still holds: **losing stack first**, then the gaining one.

The rules' cost depends on whether `infrastructure` ever records them as resources, which depends on
when the two applies happen relative to the merge:

- **Applying mid-branch**, at step 2's or step 3's human gate as the Steps section lists them,
  puts all 53 rules into `infrastructure`'s state. The step 5 apply then really deletes them
  (`DirectusPermissionRule.delete` issues `DELETE /permissions/{id}`), and the `people-hub` apply
  re-creates them — a real permission outage between the two applies. `f372ba0d`'s commit message
  describes this outage as fact. Nothing on this branch has been applied, so read that message as a
  description of this mid-branch scenario, not a report of what happened.
- **Applying once, after merge** — the prescribed path — never puts the rules into
  `infrastructure`'s state at all. Its apply only drops `permissionRules` from
  `DirectusRole`; because `clearPermissions` is gone with it, the rows stay live but unmanaged.
  `people-hub`'s `create` then adopts each row by (policy, collection, action) instead of posting a
  duplicate, and reconciles it to the declared `permissions`/`fields` (`22579b77`) — which is what
  makes adoption safe rather than merely non-duplicating. No deletion, no outage.

`just refresh` before starting, per `.claude/plans/deployer-access.md:314`: preview compares against
last-known state, not live GCP.

**Abort if** a preview on either stack proposes: deleting or replacing any `gcp:sql`, `gcp:compute`,
or `gcp:dns` resource; replacing (not updating) a `DirectusRole`; or deleting a `DirectusUser`.

### How this is verified

There is no unit test for a Pulumi program. `grantPermission`/`deletePermission` move into
`directus-client.ts`, which is pulumi-free and already unit tested by stubbing `fetch`
(`packages/infrastructure/test/directus-client.test.ts`), and get tests there. Everything else is
`just ci` plus a read `pulumi preview` on each stack at each step, checked against the abort list.

## Alternatives

- **Move the whole app slice — schema, roles, user — to the app project.** No new resource type, but
  four more resources to migrate and it contradicts the issue's identity model. Rejected, narrowly;
  it becomes wrong the moment a second app wants Staff.
- **One `DirectusPermissionSet` resource per policy** instead of 53 rule resources. Fewer resources,
  but a partially failed create orphans rows it never recorded. Rejected.
- **`pulumi state move` for the schema resource.** Supported by the pinned CLI (v3.192.0), but state
  surgery for a resource whose delete is a no-op and whose create is idempotent. Rejected.
- **Leave the rules inside `DirectusRole` and keep both stacks writing the policy.** This is the
  clobber of `deployer-access.md:299` with a different resource type. Rejected.

## Decisions

1. **Project location:** `packages/infrastructure/src/people-hub/`, beside the other two projects.
   Extracting the `Directus*` classes into a `packages/directus/` package belongs with #107.
2. **Guardian stays in `infrastructure`** with Staff and Coach. Once the filters move to the app
   alongside the rules, the role carries no people-hub detail.
3. **`just deploy` applies both projects in dependency order** — `infrastructure`, then
   `people-hub`.

## Steps

This is the build log: the order the change actually landed, one commit per step. It is not a
runbook. Do not apply at steps 2 or 3 — the Migration section above shows that applying before
`people-hub` exists puts the 53 permission rules into `infrastructure`'s state and turns step 5's
apply into a real deletion. Apply once, after every step below is merged to `main`: `just refresh`,
then `infrastructure`, then `people-hub`, per Migration.

1. **Extract the shared Directus module.** Move the `Directus*` classes and `directus-client.ts`
   from `src/infrastructure/` to `src/directus/`; leave the instance resources in
   `src/infrastructure/directus.ts`. Update imports, including the test's. Pure code move.
   `pulumi preview` may show updates on the three dynamic resources from provider re-serialization —
   harmless and idempotent — but must show no replace and no delete.
2. **Make permission rules their own resource.** Add `DirectusPermissionRule`; remove
   `permissionRules` and `clearPermissions` from `DirectusRole`; declare the 53 rules in
   `people-hub.ts` against each role's `policyId`. Still one project. Unit tests for the new
   client helpers.
   - **human:** apply `infrastructure`; confirm in Directus that each role's rules are intact.
3. **Split roles and users out of `people-hub.ts`** into `src/infrastructure/directus-roles.ts`, and
   export `directusBaseUrl` and the three policy IDs from `src/infrastructure/index.ts`. No resource
   changes; `pulumi preview` shows outputs only.
   - **human:** apply `infrastructure` so the outputs exist for step 4.
4. **Add the `people-hub` project.** `Pulumi.yaml`, `Pulumi.prod.yaml` (`gcp:project` only),
   `package.json` marker, `refs.ts`, and the schema plus rules declarations. Add the justfile
   recipes and script per Open question 3. Nothing applied yet — applying both stacks now would
   duplicate every permission row.
   - **human:** `pulumi stack init prod --cwd ./packages/infrastructure/src/people-hub`.
5. **Cut over.** Delete the schema and rule declarations from `infrastructure`, leaving roles and the
   user behind.
   - **human:** `just refresh`, then apply `infrastructure` (losing stack), read the diff against the
     abort list, then apply `people-hub` (gaining stack). Verify the collections still exist and
     each role's rules are back.
6. **Docs.** `packages/infrastructure/README.md:5` (three projects), `packages/people-hub/README.md`
   (its own project now), and `docs/manual-setup.md` §6 — drop the "on a truly fresh deploy this is
   often the second `pulumi up`" concession, which project ordering now handles.

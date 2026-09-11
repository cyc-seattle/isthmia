# Let an it-admin developer deploy without master@

Issue [#87](https://github.com/cyc-seattle/isthmia/issues/87), parts 1 and 2. Part 3 (GitHub
Actions) is [#118](https://github.com/cyc-seattle/isthmia/issues/118) and is out of scope. The
`dependabot.yml` item is out of scope too.

## Context

Deploy rights are granted to individual users in `packages/infrastructure/src/config.ts:14`. That
list holds `roles/run.developer` (`run-reports-job.ts:126`), `roles/artifactregistry.writer`
(`artifact-repository.ts:29`), and IAP SSH (`compute.ts:38`). It does not cover Compute, Cloud SQL,
DNS, Secret Manager, or service-account IAM, so `ungood@` cannot run a full `pulumi up`. The #64 and
#97/#100 deploys were finished as `master@`, which is what the access policy in CLAUDE.md forbids.

The blocker to just widening that list: `infrastructure` creates project-level IAM itself
(`compute.ts:30`, `compute.ts:38`, `run-reports-job.ts:126`). A deployer who can apply those
resources needs `resourcemanager.projects.setIamPolicy`, which lets it grant itself Owner. Least
privilege would then be cosmetic.

Three tooling faults make every credential mistake expensive:

- `getClientConfig({})` runs at module scope (`substrate.ts:52`, `run-reports-job.ts:42`). An
  expired token kills the whole program before it can produce a diff.
- The auth tables in `README.md:48` and CLAUDE.md say `pulumi` and `docker` use the
  `gcloud auth login` session. They use ADC. `just auth-adc` (`justfile:15`) points ADC at
  `report-runner@`, so a deploy runs as the wrong identity and 403s.
- `just check` (`justfile:24`) both formats and lints, so a formatting-only failure blocks the run.

Already done, do not redo: `just deploy *args` forwards to `pulumi up` (`justfile:57`), so `--yes`
works. `scripts/auth-status` exists and prints account, configuration, project, and resolved ADC
identity.

## Approach

### 1. New `packages/bootstrap` Pulumi project

A new workspace package with its own `Pulumi.yaml` (project `bootstrap`, stack `prod`) and
`Pulumi.prod.yaml` setting `gcp:project`. It owns:

- A custom role `deployer` (`gcp.projects.IAMCustomRole`), plus a set of predefined roles, bound to
  `group:it-admins@cyccommunitysailing.org` and to `user:master@cyccommunitysailing.org` as
  break-glass. See "Permissions" below.
- Both service accounts, moved from `compute.ts:24` and `run-reports-job.ts:21`.
  `packages/infrastructure/src/service-account.ts` moves here with them — after the move
  `infrastructure` creates no service account.
- Every `gcp.projects.IAMMember`: `compute.ts:30-36`, `compute.ts:38-51`, `run-reports-job.ts:126`.
- The human-facing impersonation grants (`allowImpersonation`, `run-reports-job.ts:23`), because
  they decide who can act as an identity.

Exports `substrateRunner` and `reportRunner` as `{ email, member, name }`. Those three strings cover
every consumption site: `compute.ts:82`, `substrate.ts:26,33,45`, `portal.ts:24`, `directus.ts:52`,
`run-reports-job.ts:32,77,123,148`.

Resource-scoped IAM stays in `infrastructure`: `artifact-repository.ts:29`, `substrate.ts:32`,
`substrate.ts:40`, and `Secret.grant` (`secret.ts:24`).

**Naming.** `packages/bootstrap` is the access/identity Pulumi project. It is unrelated to
`substrate-bootstrap.ts` and `substrate-bootstrap-script.ts`, which build the VM's cloud-init. Keep
the `substrate-` prefix on those, and do not create a file named `bootstrap.ts` in the new package.
Say this in the new package's README.

### 2. How `infrastructure` reads the identities

**Pulumi `StackReference` to `bootstrap`.** A new `packages/infrastructure/src/identities.ts`
creates one `pulumi.StackReference` and exports two typed identity objects. Consumers import from
there instead of `compute.ts`. The stack name comes from config (`bootstrapStack`, defaulting to
`ungood/bootstrap/${pulumi.getStack()}`) so the Pulumi org is not hardcoded.

This costs nothing today. The Pulumi backend is Pulumi Cloud under the single account `ungood`
(`~/.pulumi/credentials.json`), so both stacks are already readable by the one identity that
deploys. A second it-admin needs write on the `infrastructure` stack anyway, which puts them in the
same Pulumi org. `bootstrap` exports no secret values.

### 3. Permissions for the deployer grant

Bound to the group and to `user:master@`:

| Role                                    | Needed by                                        |
| --------------------------------------- | ------------------------------------------------ |
| `roles/serviceusage.serviceUsageAdmin`  | `enableService` (`services.ts:17`)               |
| `roles/compute.admin`                   | `network.ts`, `compute.ts:54,62`                 |
| `roles/compute.osLogin`                 | IAP SSH (already granted, `compute.ts:40`)       |
| `roles/iap.tunnelResourceAccessor`      | IAP SSH (already granted, `compute.ts:40`)       |
| `roles/cloudsql.admin`                  | `database.ts`, and `gcloud sql instances list`   |
| `roles/servicenetworking.networksAdmin` | `network.ts:54`                                  |
| `roles/dns.admin`                       | `dns.ts`, `portal.ts:29`, `directus.ts:83`       |
| `roles/artifactregistry.admin`          | `artifact-repository.ts:8,30`, `substrate.ts:40` |
| `roles/secretmanager.admin`             | `secret.ts`, the `secrets.create` denial         |
| `roles/run.developer`                   | `run-reports-job.ts:68,118` (already granted)    |
| `roles/cloudscheduler.admin`            | `run-reports-job.ts:136`                         |

Custom role `deployer`, for what no predefined role grants without over-granting:

```
resourcemanager.projects.get
iam.serviceAccounts.get
iam.serviceAccounts.list
iam.serviceAccounts.getIamPolicy
iam.serviceAccounts.setIamPolicy
iam.roles.get
iam.roles.list
```

Excluded on purpose: `resourcemanager.projects.setIamPolicy` (and therefore
`roles/resourcemanager.projectIamAdmin`), `iam.serviceAccounts.create/delete/update`, and
`iam.roles.create/update/delete`. A deployer can neither grant itself a project role nor edit its
own role.

**Correction to the issue.** #87 says the role excludes IAM-policy writes on service accounts. It
cannot: `substrate.ts:32` creates a `gcp.serviceaccount.IAMMember` and stays in `infrastructure`, so
`iam.serviceAccounts.setIamPolicy` is required. The residual risk is that a deployer can grant
itself token creator on any service account in the project. The blast radius is bounded by what
those accounts hold, and `bootstrap` now owns every project-level grant to them, so the bound is
reviewable in one file.

Attaching a service account to the VM (`compute.ts:81`) and to the Cloud Run job
(`run-reports-job.ts:77`) needs `iam.serviceAccounts.actAs`. Grant it per service account, not
project-wide `roles/iam.serviceAccountUser`.

**Timing matters.** Only `master@` holds `actAs` today, which is part of why the #64 deploy needed
the super-admin. `bootstrap` does not own the service accounts until step 8, so step 4 grants
`roles/iam.serviceAccountUser` on each account addressed by its literal email
(`substrate-runner@<project>.iam.gserviceaccount.com`, and likewise for `report-runner`). A
`gcp.serviceaccount.IAMMember` can reference an account another stack owns. Step 8 replaces those
literal-email grants with `allowImpersonation` calls once `bootstrap` owns the accounts. Without
this, the full deploy that verifies step 5 still fails on `compute.Instance`.

### 4. Migrating the moved resources without destroying them

Deleting and recreating either service account is unsafe. `substrate-runner`'s domain-wide
delegation is authorized by its numeric client ID (`docs/manual-setup.md:99`), which a recreated
account does not keep. Deleting a `gcp.projects.IAMMember` really removes the binding, so a
destroy-then-create across two stacks can revoke the deployer's own IAP SSH mid-sequence.

The migration is therefore: mark `retainOnDelete: true` in `infrastructure` and apply; create or
import the resource in `bootstrap` and apply as `master@`; then delete the code from
`infrastructure` and apply, which drops it from state and leaves the cloud resource alone.

- Service accounts: `pulumi import` them into `bootstrap` before its first `up` (an operator step,
  recorded in `docs/manual-setup.md`), so the code stays clean of `import` options.
- `gcp.projects.IAMMember`: adding the same (project, role, member) from a second stack is
  idempotent in GCP, so `bootstrap` can simply create them.

### 5. Local tooling

- **`scripts/doctor`** replaces `scripts/auth-status`, keeping its three read-only lines and adding
  checks. `just doctor` replaces `just auth-status`; `deploy` and `preview` depend on it. It reports
  every failure, not the first, and exits non-zero. Each failure prints one fix command.

  | Check                                                 | Fix printed                                |
  | ----------------------------------------------------- | ------------------------------------------ |
  | `gcloud`, `pulumi`, `just`, `podman` on PATH          | `direnv allow`                             |
  | gcloud active account is set, in the `isthmia` config | `just auth-gcp`                            |
  | ADC file present                                      | `just auth-adc`                            |
  | ADC token is live (tokeninfo resolves)                | `just auth-adc`                            |
  | ADC identity is a user, not `report-runner@`          | `just auth-adc`                            |
  | `gcloud projects describe cyc-admin-scripts` succeeds | ask an it-admin to add you to `it-admins@` |
  | `pulumi whoami` succeeds                              | `pulumi login`                             |
  | `scripts/podman-docker-host` exits 0                  | `podman machine start`                     |

- **Lazy `getClientConfig`.** Move `substrate.ts:52` and `run-reports-job.ts:42` inside their
  `docker.Image` `registries` block, as `gcp.organizations.getClientConfigOutput({}).accessToken`.
  An expired token then fails one resource with a named error.

- **Project-local credentials.** `.envrc` sets `CLOUDSDK_CONFIG` **and**
  `GOOGLE_APPLICATION_CREDENTIALS`. Both are needed: `google-auth-library` reads
  `$HOME/.config/gcloud/application_default_credentials.json` and ignores `CLOUDSDK_CONFIG`
  (`googleauth.js:340-346`), and the Go provider behind `@pulumi/gcp` behaves the same way.
  `.gitignore` gains `.gcloud/`. `just create-config` (`justfile:9`) survives unchanged — it now
  creates the `isthmia` configuration inside the project-local directory, which is still what
  `CLOUDSDK_ACTIVE_CONFIG_NAME` in `flake.nix:76` selects.

- **`just auth-adc`** drops `--impersonate-service-account`, so ADC is you. That is what makes a
  deploy run as you.

- **New recipes:** `just preview` (same podman and tunnel setup as `deploy`, extracted into a shared
  private recipe), `just ssh`, `just logs <service>` (both reuse the VM name/zone lookup already in
  `db-tunnel`, `justfile:44`), and `just deploy-bootstrap` for the `master@` apply.

- **`just fmt`** runs `treefmt`; `just check` keeps `treefmt --fail-on-change` plus eslint.

- **Docs:** correct the credential tables in `README.md:48` and CLAUDE.md — Pulumi and docker
  authenticate with ADC, not with the `gcloud auth login` session.

### How this is verified

There is no unit test for a Pulumi program, and the existing tests mock the SDK boundary
(`packages/infrastructure/test/substrate-bootstrap-script.test.ts`). Verification is:

- `pulumi preview` on each stack after each step, which must show the intended diff and no
  unintended delete.
- `gcloud projects get-iam-policy cyc-admin-scripts` after each `bootstrap` apply.
- `just doctor` run in both a good and a deliberately broken credential state.
- `just ci` for the pure-code steps.

## Alternatives

- **One custom role holding every permission.** Hand-maintaining the compute, Cloud SQL, and DNS
  permission lists guarantees the mid-apply denial this issue exists to remove. Rejected; see
  Decisions.
- **Look the service accounts up with `gcp.serviceaccount.getAccountOutput`.** Adds a live GCP read
  to every preview and gives no ordering guarantee. Rejected.
- **Derive the emails as plain constants** (`${accountId}@${projectId}.iam.gserviceaccount.com`).
  Simplest, but duplicates the account IDs across two Pulumi projects with nothing tying them
  together. Rejected, narrowly.
- **Grant the deployer `resourcemanager.projectIamAdmin` and keep project IAM in
  `infrastructure`.** One `master@` apply saved per new app, at the cost of self-escalation to
  Owner. Rejected; this is the whole point of the issue.
- **Put `bootstrap` in `packages/infrastructure/bootstrap/`** with a `main:` pointing back at
  `src/`. Avoids a new package but crosses two Pulumi projects over one TypeScript build. Rejected.

## Decisions

Settled 2026-09-11, before implementation.

1. **Predefined roles plus a narrow custom role**, as in "Permissions" above — not the single
   all-encompassing `deployer` role #87 asked for. A hand-maintained list of several hundred
   permissions drifts every time a resource type is added, and it fails partway through an apply,
   which is the pain this issue exists to remove.
2. **`CLOUDSDK_CONFIG` points at the git common dir** (`$(git rev-parse --git-common-dir)/..`), so
   every worktree of this repo shares one credential set. The goal is isolation from your personal
   gcloud config, not isolation between worktrees; `$PWD` would force a fresh `auth-gcp` and
   `auth-adc` in every new session worktree.
3. **`just auth-status` goes away.** `just doctor` supersedes it; no alias.
4. **`master@` gets no separate Pulumi Cloud login.** `bootstrap` applies are attributed to the
   Pulumi account `ungood` while acting with `master@`'s gcloud credentials. Accepted: the GCP audit
   log records the real acting identity, which is the one that matters for access review.
5. **`commander@` is not added yet.** It goes in when #81 lands, not as a commented placeholder.

## Steps

Each step is one dispatch and one commit. Steps marked **human** need an action between commits.

1. **Split `just fmt` from `just check`, and add `preview`, `ssh`, and `logs`.** Extract the podman
   and tunnel preamble from `deploy` (`justfile:57`) into a shared private recipe. No auth or IAM
   change. Verified by `just ci` and `just preview`.
2. **Add `scripts/doctor` and `just doctor`.** Replaces `scripts/auth-status` and `just auth-status`
   (`justfile:19`, `README.md:67`). `deploy` and `preview` depend on it. The "ADC is not
   `report-runner@`" check is a warning at this point, not a failure — it becomes a failure in
   step 6.
3. **Make `getClientConfig` lazy.** `substrate.ts:52` and `run-reports-job.ts:42` move inside their
   `docker.Image`. Verified by `pulumi preview` showing no diff.
4. **Add `packages/bootstrap` with the roles and the group bindings only.** No resource moves yet.
   Keep every existing per-user grant in place. Includes the predefined-role bindings, the custom
   `deployer` role, the `roles/iam.serviceAccountUser` grants on both service accounts by literal
   email (see "Timing matters" above — step 5 cannot be verified without them), the new package's
   README (with the naming note), and a `docs/manual-setup.md` section covering the `it-admins@`
   group's join and invite settings and the `master@` apply procedure.
   - **human, before the commit:** confirm in the Workspace Admin console that `it-admins@` is
     invited-only with managers-only invites, and record the settings in `docs/manual-setup.md`.
   - **human, after the commit:** `master@` runs `just deploy-bootstrap`. Wait several minutes for
     group membership to reach IAM, then confirm with `gcloud projects get-iam-policy` and a
     `pulumi preview` as `ungood@`.
5. **Switch ADC to your own identity and fix the docs.** `.envrc` gains `CLOUDSDK_CONFIG` and
   `GOOGLE_APPLICATION_CREDENTIALS`, `.gitignore` gains `.gcloud/`, `just auth-adc` drops the
   impersonation flag, and the credential tables in `README.md:48` and CLAUDE.md are corrected.
   - **human, after the commit:** re-run `just auth-gcp` and `just auth-adc`, then `just doctor` and
     a full `just deploy` as yourself. This is the step that proves the issue is solved. It works
     only because step 4 granted `actAs` on both service accounts; if the deploy fails on
     `compute.Instance`, that grant is what to check first.
6. **Promote the `doctor` ADC check to a failure.** One line, separated from step 5 so a bad check
   cannot block the verification run.
7. **Mark the moving resources `retainOnDelete`.** The two service accounts (`compute.ts:24`,
   `run-reports-job.ts:21`) and the three project IAM blocks (`compute.ts:30`, `compute.ts:38`,
   `run-reports-job.ts:126`). Apply; `pulumi preview` must show metadata-only changes.
8. **Declare the identities in `bootstrap`.** Service accounts, `service-account.ts` moved over,
   `allowImpersonation` grants replacing step 4's literal-email `iam.serviceAccountUser` bindings,
   and the three project IAM blocks. Export `{ email, member, name }` for each. The binding must not
   lapse between the two forms — grant through `allowImpersonation` before removing the literal
   ones, or you lose the ability to deploy the VM.
   - **human, before applying:** `master@` runs `pulumi import` for both service accounts, per the
     procedure added in step 4.
   - **human:** `master@` runs `just deploy-bootstrap`.
9. **Point `infrastructure` at the `bootstrap` stack.** Delete the moved code, add
   `src/identities.ts` with the `StackReference`, and repoint `compute.ts`, `substrate.ts`,
   `portal.ts`, `directus.ts`, and `run-reports-job.ts`. Keep `enableService("iap.googleapis.com")`
   in `compute.ts` even though its `dependsOn` consumer moved. Verified by a `pulumi preview` that
   shows deletes only from state, never from GCP.
10. **Add the group to `deployers` alongside the existing users** (`config.ts:14`). Additive only,
    so the artifact registry binding (`artifact-repository.ts:29`) never has a gap. Apply and verify
    that `ungood@` can still push an image.
11. **Remove the per-user entries.** `config.ts:14` becomes
    `["group:it-admins@cyccommunitysailing.org"]`, and `bootstrap` drops the per-user members while
    keeping `user:master@` break-glass.
    - **human:** apply `bootstrap` as `master@` first, then `infrastructure` as yourself.

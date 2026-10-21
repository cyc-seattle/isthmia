# Moving prod's state out of `infrastructure`

Step 8 of #231 moves prod's app resources from `infrastructure`'s state into `authentik`, `crm`,
`clubspot-sync`, and `gsuite-sync`. Nothing in the cloud changes. The VM keeps running everything,
and each project's prod stack keeps its workloads off the cluster (`<project>:onCluster: false`) until
its own move.

`scripts/move-prod-state` does the work. It's a dry run by default, and `--apply` performs it. A
second run skips whatever is already done.

| Project         | What moves in                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentik`     | The generated `authentik-*` secrets and `directus-oidc-client-secret`, each with its `RandomBytes` and `SecretVersion`. The `google-oauth-client-id` and `-secret` containers. The `authentik` database user and database. The `login.` record              |
| `crm`           | The generated `directus-*` secrets and both sync tokens. The `directus-license-key` and `directus-community-role-id` containers, and the role ID's version. The `directus` database user and database. The `directus.` record. Every Directus role and user |
| `clubspot-sync` | The `clubspot-username` and `clubspot-password` containers                                                                                                                                                                                                  |
| `gsuite-sync`   | The `admin` and `groupssettings` API enablements                                                                                                                                                                                                            |

`infrastructure` keeps the VM, its address, firewall rules, and compose apply, the substrate image,
the Cloud Run jobs and schedulers, the `cycsail.team` record, the shared API enablements, and every
Secret Manager grant. The grants belong to what reads the secrets: the VM and the Cloud Run jobs.

The two databases were `postgresql.Database`, created over the IAP tunnel. The script removes them
from `infrastructure`'s state and imports them into their project as `gcp.sql.Database`, protected,
which reads them through the Admin API and changes nothing in Postgres. Directus keeps its database,
so it keeps its license activation (#172).

## Prerequisites

- The deployer's access: `mise run auth-gcp` and `mise run auth-adc`, `roles/owner` on the project,
  and a place in platform's `bootstrap:humanDeployers` for prod's state bucket and KMS key.
- Docker running. `infrastructure`'s preview builds the substrate image.
- Nobody else deploying prod. Prod deploys run from laptops, so say so before starting.
- A checkout of the branch that carries this change, with `mise run install` run. Its code expects
  the moved state, so **never run a prod `up` with it before the move**: `infrastructure` would
  delete the moved resources. Run the move, then merge.
- Every command runs under the workplace's mise env with `PULUMI_STACK=prod`, so `pulumi` uses prod's
  backend. Check with `pulumi whoami -v`.

## Steps

1. Record the baseline: what prod's previews show before the move. Run them from `main`, since the
   branch's code would preview against the old state. Any change listed here is unrelated to the
   move, and shows again in step 5.

   ```sh
   git switch main
   PULUMI_STACK=prod mise exec -- ./scripts/each-stack preview --diff
   git switch -
   ```

2. Back up each existing stack's state to a dated directory outside the repo. The files hold
   ciphertext only, and prod's KMS key decrypts it.

   ```sh
   backup=~/pulumi-backups/$(date +%F)
   mkdir -p "$backup"
   for project in infrastructure authentik crm; do
     PULUMI_STACK=prod mise exec -- pulumi stack export --stack "organization/$project/prod" --file "$backup/$project.json"
   done
   ```

3. Dry run. It lists every step and changes nothing.

   ```sh
   PULUMI_STACK=prod mise exec -- ./scripts/move-prod-state
   ```

   It should create the `clubspot-sync` and `gsuite-sync` prod stacks, move 19 resources to
   `authentik`, 33 to `crm`, 2 to `clubspot-sync`, and 2 to `gsuite-sync`, import two databases, and
   delete two `postgresql` databases and their providers from `infrastructure`'s state.

4. Apply.

   ```sh
   PULUMI_STACK=prod mise exec -- ./scripts/move-prod-state --apply
   ```

   Besides the moves, it writes state with `pulumi stack import` twice per destination:

   - Before a move, it records `infrastructure`'s default provider inputs on the destination's
     default provider of the same type. `pulumi state move` reuses a destination provider only when
     its inputs are equal, and otherwise refuses. The next `up` records the destination's own.
   - After a database import, it records `deletionPolicy: ABANDON`, which lives only in state. An
     import records the default, `DELETE`.

5. Read the previews the script ends with. Each must show no change beyond step 1's baseline:

   | Project          | Expect                                      |
   | ---------------- | ------------------------------------------- |
   | `infrastructure` | the baseline's changes only, and no deletes |
   | `authentik`      | no changes                                  |
   | `crm`            | the baseline's changes only                 |
   | `clubspot-sync`  | no changes: 2 secrets and the stack         |
   | `gsuite-sync`    | no changes: 2 API enablements and the stack |

   A `read` of a StackReference, or a `discard` of an old one, isn't a change. If anything else
   shows, roll back before running anything else.

6. Merge the change. `scripts/each-stack` deploys `infrastructure`, `authentik`, and `crm` in prod.
   `clubspot-sync` and `gsuite-sync` change nothing until their move, so it can skip them till then.

## Rolling back

The backups from step 2 restore the old ownership. Run them with the code from before this change.

```sh
backup=~/pulumi-backups/<date>
for project in infrastructure authentik crm; do
  PULUMI_STACK=prod mise exec -- pulumi stack import --stack "organization/$project/prod" --file "$backup/$project.json"
done
for project in clubspot-sync gsuite-sync; do
  # --force removes the stack's state only. The secrets and APIs stay, owned again by infrastructure.
  PULUMI_STACK=prod mise exec -- pulumi stack rm "organization/$project/prod" --force --yes
done
```

Then preview `infrastructure`, `authentik`, and `crm` from `main` before this change, through
`scripts/each-stack`, and compare with step 1.

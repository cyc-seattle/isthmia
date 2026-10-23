# Retiring the substrate VM

Step 12 of #231. Since steps 9–11, the VM `substrate-86eed8d` runs only Caddy, and no hostname
points at its address, `136.109.86.99`. Everything it served runs in the cluster's `prod`
namespace. This deletes the VM and everything that existed only for it, and moves prod deploys to
Actions (#118).

| What                                                                                                                                                                           | Where                       | How                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------- |
| The VM, its address, the `allow-https` and `allow-ssh-iap` firewall rules, `substrate-apply`, the substrate image, and `substrate-runner`'s Secret Manager and registry grants | `infrastructure/prod` state | `pulumi destroy`, then `pulumi stack rm` |
| The `infrastructure` project, `packages/substrate`, and the `ssh`, `db-tunnel`, and old `logs` tasks                                                                           | isthmia                     | isthmia#259                              |
| `substrate-runner`, its grants, the deployers' IAP SSH grants, and `deploy-runner`'s OS Login, IAP, Cloud Run, and Scheduler roles                                             | platform's `bootstrap`      | platform#32, applied by hand             |
| The VM's address in the Workspace SMTP relay rule                                                                                                                              | Workspace Admin console     | The maintainer, by hand                  |

Nothing moves out of `infrastructure` first. Besides the VM's own resources, it holds eight API
enablements and two StackReferences. Every enablement has `disableOnDestroy: false`, so the destroy
leaves each API on, and platform already declares six of them: Compute, Service Networking, Cloud
SQL Admin, DNS, and Artifact Registry in `cloud`, and IAP in `bootstrap`. platform#32 adds Secret
Manager to `cloud`. OS Login served only the VM. No other stack reads `infrastructure`'s outputs:
`crm` read `directusBaseUrl` until isthmia#259, and nothing reads `publicIp` or `internalDomain`.

## The disk

No snapshot. The VM's one disk, `substrate-86eed8d` (30 GB, Container-Optimized OS, deleted with
the VM), holds nothing that isn't kept somewhere else:

- Caddy's ACME account and certificates. The Gateway's Certificate Manager certificate serves
  every hostname now.
- `/var/substrate/substrate.env`, a copy of prod's secrets that `apply.sh` fetched at boot:
  Directus's key, secret, database and admin passwords, and license key, and Authentik's secret
  key, database password, and bootstrap token and password. Secret Manager and the `authentik` and
  `crm` stacks keep them all.
- Docker's images, and the compose file and `apply.sh`, which git holds.

Directus's data is in Cloud SQL, and its uploads were never on a volume. A snapshot would only keep
one more copy of prod's secrets.

## Prerequisites

- Both PRs green and approved, but **not merged**. The destroy runs from `main` before isthmia#259
  deletes the project.
- The deployer's access: `mise run auth-gcp` and `mise run auth-adc`, `roles/owner` on the project,
  and a place in platform's `bootstrap:humanDeployers`. Applying `bootstrap` also needs `gh` with
  `admin:org`.
- Docker running. The destroy configures the docker-build provider for `substrate-image`.
- Nobody else deploying prod.
- A checkout of isthmia's `main`, before the merge, with `mise run install` run.
- Every command runs from that checkout's root under the workplace's mise env.

The commands below use these:

```sh
export PULUMI_STACK=prod
infra() { mise exec -- env -u DOCKER_HOST pulumi "$@" --cwd packages/infrastructure/src/infrastructure --stack prod; }
k() { kubectl --context gke_cyc-admin-scripts_us-west1_cyc -n prod "$@"; }
```

Every `pulumi` command runs with `env -u DOCKER_HOST`: a local `DOCKER_HOST` makes the docker-build
provider record a per-user socket (#208).

## Before

These change nothing.

1. Back up the state.

   ```sh
   backup=~/pulumi-backups/$(date +%F)-retire-vm
   mkdir -p "$backup"
   mise exec -- pulumi stack export --stack organization/infrastructure/prod --file "$backup/infrastructure.json"
   ```

2. Preview the destroy, and compare.

   ```sh
   infra destroy --preview-only > "$backup/destroy-preview.txt"
   ```

   Expect 26 deletes, plus the providers and the stack: `substrate` (the instance), `substrate`
   (the address), `allow-https`, `allow-ssh-iap`, `substrate-apply`, `substrate-image`,
   `substrate-image-pull`, 11 `secret-accessor-*-substrate-runner` grants, and 8 `enable-*`
   services. Anything else, stop.

3. Check that nothing still points at the VM. Both print nothing.

   ```sh
   for zone in $(gcloud dns managed-zones list --format='value(name)'); do
     gcloud dns record-sets list --zone "$zone" --format='value(name,rrdatas.list())' | grep 136.109.86.99
   done
   k get pods -o wide | grep -i substrate
   ```

## The steps

1. **Destroy `infrastructure`.** The VM serves nothing, so this takes nothing down.

   ```sh
   infra destroy --yes
   gcloud compute instances list --filter='name~substrate'           # nothing
   gcloud compute addresses list --filter='name~substrate'           # nothing
   gcloud compute firewall-rules list --filter='name~allow-https OR name~allow-ssh-iap'   # nothing
   ```

   A failed destroy leaves the rest in state. Run it again.

2. **Remove the stack.** `--preserve-config` keeps the checkout clean, since isthmia#259 deletes
   the file anyway.

   ```sh
   infra stack rm --yes --preserve-config
   ```

3. **Merge isthmia#259.** `main`'s run deploys dev, then runs `prod-preview` as `deploy-runner`,
   prod's first preview from Actions. Read its summary:

   | Project         | Expect                                                                  |
   | --------------- | ----------------------------------------------------------------------- |
   | `authentik`     | `changes=false`                                                         |
   | `crm`           | `changes=false`                                                         |
   | `portal`        | `changes=true`: only the `portal` Deployment's image, by its new digest |
   | `clubspot-sync` | `changes=true`: only the `clubspot-sync` CronJob's image                |
   | `gsuite-sync`   | `changes=true`: only the `gsuite-sync` CronJob's image                  |

   Dev builds a new digest for every commit, so every merge shows those three image updates until
   #258. The code in them is unchanged. Anything else is a real change: stop and read it. A
   permission error means `deploy-runner` lacks a grant that a laptop's Owner had.

   Then approve the `prod` job, and check that it rolled out:

   ```sh
   k rollout status deploy/portal --timeout=5m
   k get cronjob clubspot-sync gsuite-sync -o jsonpath='{range .items[*]}{.metadata.name} {.spec.jobTemplate.spec.template.spec.containers[0].image}{"\n"}{end}'
   ```

4. **Merge platform#32.** Its `main` run previews `cloud`, with one create
   (`enable-secretmanager.googleapis.com`, a no-op on an enabled API), and `cluster` unchanged.
   Approve its `prod` job.

5. **Apply `bootstrap`**, from platform's `main` after the merge. The VM is gone, so
   `substrate-runner` has nothing left to run.

   ```sh
   mise run preview-bootstrap
   mise run deploy-bootstrap
   ```

   Expect 11 deletes: `substrate-runner`, its `logging.logWriter` and `monitoring.metricWriter`
   grants, `deploy-runner-user-substrate-runner`, the two `substrate-ssh-*` grants per human
   deployer, `deploy-runner`'s `compute.osLogin`, `iap.tunnelResourceAccessor`, `run.developer`,
   and `cloudscheduler.admin`, and `enable-iap.googleapis.com` (the API stays on). The preview
   also shows `workplace`'s secret scanning and push protection going from `disabled` to
   `enabled`. That isn't this change: someone turned them off by hand, and `bootstrap` turns them
   back on.

6. **The maintainer's Workspace edits**, in the Admin console as a super-admin:

   - Apps → Google Workspace → Gmail → Routing → SMTP relay service: remove `136.109.86.99` from
     the rule. Keep the cluster's Cloud NAT address, `136.66.241.50`.
   - Security → API controls → Domain-wide delegation: remove `substrate-runner`'s client,
     `115457003008765084595`, if it's still listed (docs/manual-setup.md §5.2).

7. **Optional cleanup**, by hand:

   - The `substrate` image in Artifact Registry. The docker-build provider never deletes a pushed
     image.

     ```sh
     gcloud artifacts docker images delete us-west1-docker.pkg.dev/cyc-admin-scripts/artifact-docker-repository/substrate --delete-tags --quiet
     ```

   - The org's `roles/compute.osLoginExternalUser` for each deployer, which only IAP SSH needed.

## Verification

1. Every hostname answers from the Gateway, `34.49.244.55`.

   ```sh
   for host in cycsail.team login.cycsail.team directus.cycsail.team; do dig +short "$host"; done
   curl -fsS -o /dev/null -w '%{http_code}\n' https://cycsail.team/welcome             # 200
   curl -fsS -o /dev/null -w '%{http_code}\n' https://login.cycsail.team/-/health/live/  # 200 or 204
   curl -fsS https://directus.cycsail.team/server/ping                                  # pong
   ```

2. The workloads are untouched.

   ```sh
   k get deploy,cronjob
   ```

   Four Deployments ready, and both CronJobs with a recent `LAST SCHEDULE`.

3. The identity and IAP grants are gone.

   ```sh
   gcloud iam service-accounts list --filter='email~substrate-runner'   # nothing
   gcloud projects get-iam-policy cyc-admin-scripts --format=json \
     | jq -r '.bindings[] | select(.role | test("osLogin|iap.tunnel|run.developer|cloudscheduler")) | .role'   # nothing
   ```

4. After the relay edit, the maintainer signs in to the portal with an emailed link. The email
   arrives through the relay from the Cloud NAT address.

Then say on #231 that step 12 is done, and close #107 and #117 as moot, and #118.

## Rolling back

Nothing served from the VM, so there is no service to restore.

- **A wrong delete in `infrastructure`.** Restore the backup with
  `mise exec -- pulumi stack import --stack organization/infrastructure/prod --file "$backup/infrastructure.json"`,
  then rerun `pulumi up` from the pre-merge commit. That creates a new VM and address, and the
  relay would need the new IP.
- **`prod` from Actions fails.** Fix forward in a PR, or deploy from a laptop as before: `mise run
deploy` from `main`, which now runs only the five cluster projects.
- **`bootstrap`.** Revert platform#32 and apply `bootstrap` again. A deleted service account can be
  restored for 30 days with `gcloud iam service-accounts undelete 115457003008765084595`, which
  keeps its client ID.

# Moving prod's syncs to the cluster

Step 10 of #231. clubspot-sync and gsuite-sync stop running as Cloud Run jobs with Cloud Scheduler
triggers, and start as CronJobs in the cluster's `prod` namespace. They reach Directus at
`http://directus` inside the namespace instead of its public URL. Nothing else changes: the same
Clubspot club and login, the same Directus tokens, and the same Workspace identity.

The change is three config values, all committed in the step's PR:

| Stack                 | Setting                               | Effect                                                                                                                                                                                                     |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/prod` | `infrastructure:cloudRunSyncs: false` | Deletes both Cloud Run jobs, their schedulers and invokers, the `:latest` sync images, the runners' four Secret Manager grants, and the Run and Scheduler API resources (the APIs themselves stay enabled) |
| `clubspot-sync/prod`  | `clubspot-sync:onCluster: true`       | The `clubspot-sync` CronJob, ServiceAccount, and Secret: `crm`'s `clubspotSyncToken`, and the Clubspot login read from Secret Manager's `clubspot-username` and `clubspot-password` at deploy time         |
| `gsuite-sync/prod`    | `gsuite-sync:onCluster: true`         | The `gsuite-sync` CronJob, Secret (`crm`'s `gsuiteSyncToken`), and ServiceAccount, annotated to act as `gsuite-sync@` through Workload Identity. platform's `bootstrap` already holds that binding         |

Both CronJobs run on regular capacity, with `concurrencyPolicy: Forbid`, 250m CPU and 512Mi, and the
image `main`'s dev deploy built for the commit, by digest (`deployedImage`, `src/cluster.ts`). The
size is dev's, and leaves room in prod's 3-CPU quota for a Deployment's rollout while both run.

## The schedule, and the handover

| Sync          | Cloud Run today | CronJob      |
| ------------- | --------------- | ------------ |
| clubspot-sync | `:00`, ~1 min   | `0 * * * *`  |
| gsuite-sync   | `:00`, ~7 min   | `30 * * * *` |

gsuite-sync moves to half past, as in dev. It then passes on the hour's Clubspot changes within half
an hour, and never shares the quota with clubspot-sync. CronJobs read the schedule in
`America/Los_Angeles`, which doesn't matter for an hourly one.

**Two workers must never drain one queue at once.** The queue's claim has no lease
(`packages/directus/src/queue.ts`). `Forbid` keeps a scheduled Job from starting beside another
scheduled one, but not beside a Job made by hand with `kubectl create job`. So the cutover runs
between **:31 and :45** past the hour, call it hour H:

- Both Cloud Run runs started at H:00 and finished by about H:08.
- The applies delete the schedulers first, then start the CronJobs. A CronJob created after H:30
  next runs gsuite-sync at H+1:30 and clubspot-sync at H+1:00.
- The verification runs each sync once by hand, finishing well before H+1:00.

So each sync runs at H:00 on Cloud Run, once by hand around H:40, then on its CronJob. Neither goes
more than an hour without a run, and no two runs of one sync overlap.

## Job-failure alerts

platform's `cluster` stack (`stacks/cluster/alerts.ts`, #205) already covers both CronJobs, by
namespace rather than by name:

- **"A prod Job failed"** matches any Job in `prod` whose event reason is `BackoffLimitExceeded` or
  `DeadlineExceeded`. A sync that ends with `status: failed` exits 1, and with `backoffLimit: 0` its
  Job fails at once. A run past the one-hour `activeDeadlineSeconds` fails too. This includes the
  Jobs made by hand below.
- **"A prod CronJob hasn't succeeded in 3 hours"** counts the CronJob controller's `SawCompletedJob`
  events per CronJob, labeled with its name. A series starts with a CronJob's first success, so
  until then only the failure alert covers it.

`cluster:alertEmails` is unset in prod until platform#20, so both alerts open incidents in Cloud
Monitoring and email no one.

## Prerequisites

- The deployer's access: `mise run auth-gcp` and `mise run auth-adc`, `roles/owner` on the project,
  and a place in platform's `bootstrap:humanDeployers`. Reading the Clubspot login needs Secret
  Manager access, which Owner has.
- Docker running. `infrastructure` still holds the substrate image.
- Nobody else deploying prod. Prod deploys run from laptops, so say so before starting.
- Steps 9 and 11 done: Directus runs in `prod`, and `crm`'s prod stack exports `clubspotSyncToken`
  and `gsuiteSyncToken`. Check with
  `mise exec -- env -u DOCKER_HOST pulumi stack output --stack organization/crm/prod --json | jq 'has("clubspotSyncToken") and has("gsuiteSyncToken")'`.
- The order: merge the PR, wait for `main`'s dev deploy to pass, then cut over from `main`. Both
  CronJobs look up the images that deploy built, tagged with the merge's SHA. A PR's dev deploy tags
  the merge ref's SHA, which `main` never has. Between the merge and the cutover, nobody runs a prod
  `up`: it would be the cutover.
- A checkout of `main` at the merge, with `mise run install` run.
- Every command runs from the repo's root under the workplace's mise env, with `PULUMI_STACK=prod`,
  so `pulumi` uses prod's backend.

The commands below use these:

```sh
export PULUMI_STACK=prod
up() { mise exec -- env -u DOCKER_HOST pulumi "$1" --cwd "packages/infrastructure/src/$2" --stack prod "${@:3}"; }
k() { kubectl --context gke_cyc-admin-scripts_us-west1_cyc -n prod "$@"; }
```

Every `pulumi` command runs with `env -u DOCKER_HOST`: a local `DOCKER_HOST` makes the docker-build
provider record a per-user socket, and `infrastructure` then replaces every image (#208).

## Before the window

These change nothing.

1. Back up the stacks' state to a dated directory outside the repo.

   ```sh
   backup=~/pulumi-backups/$(date +%F)-syncs-cutover
   mkdir -p "$backup"
   for project in infrastructure clubspot-sync gsuite-sync; do
     mise exec -- env -u DOCKER_HOST pulumi stack export --stack "organization/$project/prod" --file "$backup/$project.json"
   done
   ```

2. Preview all three, and compare with the PR's previews. Anything else, stop.

   ```sh
   for project in infrastructure clubspot-sync gsuite-sync; do up preview "$project" --diff > "$backup/preview-$project.txt"; done
   ```

   | Project          | Expect                                                                                                                                                                                                                            |
   | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `infrastructure` | 14 deletes, 27 unchanged: `clubspot-sync-job` and `gsuite-sync-job`, their `-runner-invoker`s, `-hourly` schedulers, and `-image`s, the four `secret-accessor-*-sync-runner` grants, and `enable-run` and `enable-cloudscheduler` |
   | `clubspot-sync`  | 5 creates, 3 unchanged: the cluster provider, the `clubspot-sync` Secret, and the `clubspot-sync` ScheduledJob with its CronJob (`0 * * * *`) and ServiceAccount. The image is `clubspot-sync@sha256:…`                           |
   | `gsuite-sync`    | 5 creates, 3 unchanged: the same for `gsuite-sync` (`30 * * * *`), with the ServiceAccount's `iam.gke.io/gcp-service-account: gsuite-sync@…` annotation                                                                           |

   `infrastructure` may also show `~ substrate-image`, `~ substrate` (`metadata`), and
   `+- substrate-apply`, with fewer unchanged. The substrate image's build context holds the
   lockfile, so it rebuilds whenever `main` changed dependencies since the last prod `up`. That's
   harmless: the VM's Caddy serves no hostname now.

   The two sync previews fail with "Can't find …: deploy this commit to dev first" if `main`'s dev
   deploy hasn't built this commit. Wait for it.

3. Check the Cloud Run runs at the top of the hour have finished: neither list shows an execution
   without a completion time.

   ```sh
   for job in clubspot-sync-job gsuite-sync-job; do
     gcloud run jobs executions list --job "$job" --region us-west1 --limit 2 --format='table(name,createTime,completionTime)'
   done
   ```

## The cutover

Start between :31 and :45.

1. Delete the Cloud Run jobs and their schedulers.

   ```sh
   up up infrastructure --yes
   gcloud scheduler jobs list --location us-west1   # no sync triggers left
   gcloud run jobs list --region us-west1           # no sync jobs left
   ```

2. Start the CronJobs.

   ```sh
   up up clubspot-sync --yes
   up up gsuite-sync --yes
   k get cronjobs   # clubspot-sync `0 * * * *` and gsuite-sync `30 * * * *`, neither suspended
   ```

## Verification

Run each sync once by hand. Before each, check that no Job of that sync is running: `ACTIVE` is 0,
and no Job without a completion is listed. If one is, wait for it.

```sh
k get cronjob clubspot-sync gsuite-sync
k get jobs -l app.kubernetes.io/name=clubspot-sync
k get jobs -l app.kubernetes.io/name=gsuite-sync
```

1. **clubspot-sync.**

   ```sh
   job=clubspot-sync-cutover-$(date +%s)
   k create job "$job" --from=cronjob/clubspot-sync
   k wait --for=condition=complete "job/$job" --timeout=20m
   k logs "job/$job" | grep -A20 'Sync run finished'
   ```

   The summary's `status` is not `failed`. A failed Job shows `condition=failed` instead, and its
   logs say why: a 401 from Directus is the token, a Parse error the Clubspot login.

2. **gsuite-sync.** It calls the real Workspace APIs as `gsuite-sync@`.

   ```sh
   job=gsuite-sync-cutover-$(date +%s)
   k create job "$job" --from=cronjob/gsuite-sync
   k wait --for=condition=complete "job/$job" --timeout=30m
   k logs "job/$job" | grep -A20 'Group sync run finished'
   ```

   The summary's `status` is not `failed`. A 403 from Google, or a credentials error, means Workload
   Identity isn't in place: check the ServiceAccount's annotation with
   `k get sa gsuite-sync -o jsonpath='{.metadata.annotations}'`.

3. **Directus received both runs.** Each run finishes its tasks in `sync_tasks`, so the newest
   `finished_at` of each queue is from the run just now.

   ```sh
   password=$(gcloud secrets versions access latest --secret=directus-admin-bootstrap-password)
   token=$(jq -n --arg password "$password" '{email: "master@cyccommunitysailing.org", password: $password}' \
     | curl -fsS -X POST https://directus.cycsail.team/auth/login -H 'Content-Type: application/json' -d @- \
     | jq -r .data.access_token)
   for queue in clubspot-sync gsuite-sync; do
     curl -fsS -G -H "Authorization: Bearer $token" https://directus.cycsail.team/items/sync_tasks \
       --data-urlencode "filter={\"queue\":{\"_eq\":\"$queue\"},\"finished_at\":{\"_nnull\":true}}" --data-urlencode 'sort=-finished_at' \
       --data-urlencode 'limit=3' --data-urlencode 'fields=queue,kind,status,finished_at,last_error' | jq .data
   done
   ```

   Each queue's newest rows are `done`, with a `finished_at` from the run just now and no
   `last_error`.

4. **The schedule.** Later, without waiting on it: `k get cronjobs` shows `LAST SCHEDULE` for both
   after their first scheduled runs, and `k get jobs` shows them complete.

Then say on #231 that step 10 is done.

## Rolling back

If a sync fails on the cluster and the cause isn't quick to fix, put it back on Cloud Run. The Cloud
Run jobs reach Directus at its public URL, which still works. From the same checkout of `main`:

1. Check no sync Job is running (as in the verification), then stop the CronJobs. Setting
   `onCluster` back deletes each CronJob, its ServiceAccount, and its Secret, and keeps the Clubspot
   login's containers and the APIs.

   ```sh
   sed -i.bak 's/clubspot-sync:onCluster: true/clubspot-sync:onCluster: false/' packages/infrastructure/src/clubspot-sync/Pulumi.prod.yaml
   sed -i.bak 's/gsuite-sync:onCluster: true/gsuite-sync:onCluster: false/' packages/infrastructure/src/gsuite-sync/Pulumi.prod.yaml
   up up clubspot-sync --yes
   up up gsuite-sync --yes
   ```

2. Recreate the Cloud Run jobs and schedulers. This rebuilds and pushes the `:latest` images, so
   Docker must be running. The schedulers fire from the next hour.

   ```sh
   sed -i.bak 's/cloudRunSyncs: false/cloudRunSyncs: true/' packages/infrastructure/src/infrastructure/Pulumi.prod.yaml
   up up infrastructure --yes
   for job in clubspot-sync-job gsuite-sync-job; do gcloud run jobs execute "$job" --region us-west1 --wait; done
   ```

3. Revert the three values in a PR, so `main` matches prod, and say on #231 what failed.

A later rollback of Directus to the VM (docs/prod-cutover-crm.md) takes `http://directus` away from
the CronJobs. Roll the syncs back first.

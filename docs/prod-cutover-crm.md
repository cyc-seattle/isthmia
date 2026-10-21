# Moving prod's Directus to the cluster

Step 9 of #231. Directus starts in the cluster's `prod` namespace against the same Cloud SQL
database (`directus`) and the same `PUBLIC_URL` (`https://directus.cycsail.team`), so it keeps its
license activation (#172). `directus.cycsail.team` moves from the VM's address to the Gateway's, and
the VM's Directus stops. Authentik, the portal, and the Cloud Run sync jobs stay where they are.

The change is two config values, both committed in #250:

| Stack                 | Setting                              | Effect                                                                                                                                                  |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/prod` | `infrastructure:directusOnVm: false` | The VM's compose file loses its `directus` service. `substrate-apply` reruns `apply.sh`, whose `up -d --remove-orphans` stops and removes the container |
| `crm/prod`            | `crm:onCluster: true`                | Directus's Deployment, Service, HTTPRoute, Secrets, and the Community query-guard hook start in `prod`, and the `directus.` record moves to the Gateway |

`crm` keeps every resource step 8 moved into it (docs/prod-state-move.md): the database and its
user, the generated secrets, the roles and users, and the record, which only changes its address.
The cluster's Directus reads `KEY`, `SECRET`, the admin and database passwords, and the Community
role's ID from those same resources, and the license key from Secret Manager's
`directus-license-key`. Nothing rotates.

**Two Directus instances must never run against the prod database at once.** The VM's stops first,
then the cluster's starts. `crm`'s `up` runs only after `infrastructure`'s has finished.

## Expected downtime

About 15 minutes for Directus at `directus.cycsail.team`: the roster in the portal, Directus's own
app, and its API. It runs from the `infrastructure` apply (step 3 below) until the laptop resolving
the name, and every client, sees the Gateway's address:

- the Directus pod's start and its migrations check, 1–2 minutes;
- the load balancer admitting the new route, a few minutes;
- the record's 300-second TTL, in parallel with both.

The portal, `login.cycsail.team`, and Authentik stay up, except a few seconds while Caddy restarts on
the new substrate image. A sync job that runs in the window fails and runs again the next hour.

## Prerequisites

- The deployer's access: `mise run auth-gcp` and `mise run auth-adc`, `roles/owner` on the project,
  and a place in platform's `bootstrap:humanDeployers`. `substrate-apply` runs `gcloud compute ssh`
  through IAP, so the gcloud CLI must be logged in, not only ADC.
- Docker running. `infrastructure` builds the substrate and sync images.
- Nobody else deploying prod. Prod deploys run from laptops, so say so before starting.
- The order: merge the PR, wait for `main`'s dev deploy to pass, then cut over from `main`. Prod
  resolves images by tag from `main`'s runs, since a PR's dev deploy tags the merge ref's SHA, not
  the PR's head. Directus is an upstream image, but the steps after this one depend on that order.
  Between the merge and the cutover, nobody runs a prod `up`: it would be the cutover.
- A checkout of `main` at the merge, with `mise run install` run.
- Every command runs from the repo's root under the workplace's mise env, with `PULUMI_STACK=prod`,
  so `pulumi` uses prod's backend.
- A window between :10 and :55 past the hour. Both Cloud Run syncs start on the hour, and gsuite-sync
  takes about 7 minutes.

The commands below use these:

```sh
export PULUMI_STACK=prod
up() { mise exec -- env -u DOCKER_HOST pulumi "$1" --cwd "packages/infrastructure/src/$2" --stack prod "${@:3}"; }
gateway=$(gcloud storage cat gs://cyc-admin-scripts-pulumi-prod/platform/outputs.json | jq -r .gatewayAddress)
```

`env -u DOCKER_HOST` keeps the docker-build provider from recording a per-user socket (#208).

## Before the window

These change nothing users see.

1. Back up the three stacks' state to a dated directory outside the repo.

   ```sh
   backup=~/pulumi-backups/$(date +%F)-crm-cutover
   mkdir -p "$backup"
   for project in infrastructure authentik crm; do
     mise exec -- pulumi stack export --stack "organization/$project/prod" --file "$backup/$project.json"
   done
   ```

2. Preview all three, and compare with the PR's previews. Anything else, stop.

   ```sh
   for project in infrastructure authentik crm; do up preview "$project" --diff > "$backup/preview-$project.txt"; done
   ```

   | Project          | Expect                                                                                                                                                                                                                                                                                                                           |
   | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `infrastructure` | `~` the three images (`contextHash`), `~ substrate` (`metadata`, the user-data's compose file), `+- substrate-apply`. No deletes                                                                                                                                                                                                 |
   | `authentik`      | 55 unchanged, and a new output, `directusOidcClientSecret`                                                                                                                                                                                                                                                                       |
   | `crm`            | `+` the `directus` WebService (Deployment, Service, ServiceAccount, HTTPRoute, HealthCheckPolicy), the `directus` and `directus-db` Secrets, the query-guard ConfigMap, `directus-ready`, the cluster provider; `~ directus-a` (`rrdatas` to the Gateway); `~ crm-schema`; new outputs `clubspotSyncToken` and `gsuiteSyncToken` |

3. Apply `authentik`. It only adds the output `crm` reads the OIDC client secret from.

   ```sh
   up up authentik --yes
   ```

4. Check the Gateway already serves the name with a valid certificate. With no route yet, it answers 404. A certificate error means platform's `prod` certificate isn't ready: stop.

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' --resolve "directus.cycsail.team:443:$gateway" https://directus.cycsail.team/server/ping
   ```

5. Record the VM's Directus as it is: healthy, and its project ID, which must be the same afterwards.

   ```sh
   curl -fsS https://directus.cycsail.team/server/ping; echo
   password=$(gcloud secrets versions access latest --secret=directus-admin-bootstrap-password)
   token=$(jq -n --arg password "$password" '{email: "master@cyccommunitysailing.org", password: $password}' \
     | curl -fsS -X POST https://directus.cycsail.team/auth/login -H 'Content-Type: application/json' -d @- \
     | jq -r .data.access_token)
   curl -fsS -H "Authorization: Bearer $token" 'https://directus.cycsail.team/settings?fields=project_id' | tee "$backup/project-id.json"
   ```

6. Check no sync job is running: neither list shows an execution without a completion time.

   ```sh
   for job in clubspot-sync-job gsuite-sync-job; do
     gcloud run jobs executions list --job "$job" --region us-west1 --limit 2 --format='table(name,createTime,completionTime)'
   done
   ```

## The cutover

1. Say that Directus is going down.

2. Stop the VM's Directus. Downtime starts when `substrate-apply` runs.

   ```sh
   up up infrastructure --yes
   ```

3. Check it has stopped. Caddy still answers for the name, with 502.

   ```sh
   mise run ssh   # then: docker ps --format '{{.Names}}'  — no directus container
   curl -sS -o /dev/null -w '%{http_code}\n' https://directus.cycsail.team/server/ping
   ```

   If a `directus` container is still listed, stop: don't start the cluster's.

4. Start Directus on the cluster, and move the record.

   ```sh
   up up crm --yes
   ```

   `directus-ready` waits, up to 15 minutes, until `https://directus.cycsail.team/server/ping`
   answers from this laptop, which means the record's new address has reached it. Only then does
   `crm-schema` apply. If the `up` fails on a Directus call, wait a minute and rerun it.

## Verification

```sh
dig +short directus.cycsail.team                              # the Gateway's address
curl -fsS https://directus.cycsail.team/server/ping; echo     # pong
kubectl --context gke_cyc-admin-scripts_us-west1_cyc -n prod get pods -l app.kubernetes.io/name=directus
kubectl --context gke_cyc-admin-scripts_us-west1_cyc -n prod logs deploy/directus | grep -iE 'licen|activation|error'
```

1. **The same instance.** Repeat step 5's login and `project_id` request. It matches
   `$backup/project-id.json`.
2. **Licensed.** The logs show no license or activation error, and `Loaded extensions:
community-query-guard`. The roster check below only works with Directus's licensed permission
   rules.
3. **SSO.** In a private window, open `https://directus.cycsail.team`, choose "Log in with
   Authentik", and land in Directus as an admin.
4. **The syncs.** Run each Cloud Run job once. Both reach Directus at its public URL, now through
   the Gateway.

   ```sh
   for job in clubspot-sync-job gsuite-sync-job; do gcloud run jobs execute "$job" --region us-west1 --wait; done
   ```

5. **The Community roster through the portal.** Sign in at `https://cycsail.team` as a guardian or
   staff member with a roster, and check the roster section loads names. It calls Directus from the
   browser with Directus's session cookie, so this checks CORS and the Community rules too.
6. **Connections.** `mise run db-shell directus`, then:

   ```sql
   SELECT datname, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;
   ```

   `db-g1-small` allows about 50 connections. Directus's pool goes up to 10, as on the VM, and the
   VM's Authentik holds about 10–15 at peak, with `CONN_MAX_AGE=0`. Cloud SQL keeps a few for itself.
   When Authentik moves (step 11) its connections leave the VM's budget and join the same total.

Then say that Directus is back.

A later rollout of the Deployment briefly runs a second pod beside the first. Both are the same
instance, with the same database, `KEY`, and URL, which Directus supports. It's the VM and the
cluster together that must never happen.

## Rolling back

If Directus on the cluster fails its license check, or a verification fails, put it back on the VM,
which kept everything it needs (#231 Decision 3). From the same checkout of `main`:

1. Stop the cluster's Directus first.

   ```sh
   kubectl --context gke_cyc-admin-scripts_us-west1_cyc -n prod scale deploy/directus --replicas=0
   ```

2. Set both values back, in the working tree only, and start the VM's Directus.

   ```sh
   sed -i.bak 's/directusOnVm: false/directusOnVm: true/' packages/infrastructure/src/infrastructure/Pulumi.prod.yaml
   sed -i.bak 's/crm:onCluster: true/crm:onCluster: false/' packages/infrastructure/src/crm/Pulumi.prod.yaml
   up up infrastructure --yes
   ```

3. Point the record back at the VM, and delete the cluster's Directus resources.

   ```sh
   up up crm --yes
   ```

4. Check `dig +short directus.cycsail.team` shows the VM's address and `/server/ping` answers. The
   rollback has the same downtime as the cutover. Revert the two config values in a PR, so `main`
   matches prod, and say on #231 what failed.

## Next: the syncs (step 10)

Step 10 moves clubspot-sync and gsuite-sync to CronJobs in `prod`, in a follow-up PR with a second
phase in this runbook. Its prerequisites:

- `crm`'s prod stack exports `clubspotSyncToken` and `gsuiteSyncToken` from this cutover on, the
  values the Cloud Run jobs use today.
- Prod images: the dev deploy builds each image at the commit's SHA, and prod resolves that tag to a
  digest instead of building (#231 §7). `appImage` in `src/cluster.ts` builds today.
- `clubspot-sync`'s prod CronJob reads `clubspot-username` and `clubspot-password` from Secret
  Manager at deploy time, and Clubspot's real server.
- `gsuite-sync`'s prod CronJob runs as the `gsuite-sync` Kubernetes ServiceAccount, which platform's
  `bootstrap` already lets impersonate `gsuite-sync@`, so it needs the annotation for it and the real
  Workspace API (no `GSUITE_ROOT_URL`).
- Both reach Directus at `http://directus` in the namespace.
- `infrastructure` deletes both Cloud Run jobs, their invokers, schedulers, images, and the
  `clubspot-sync-runner` and `gsuite-sync-runner` secret grants, in the same `up` that the CronJobs
  start after, so no hour runs both.

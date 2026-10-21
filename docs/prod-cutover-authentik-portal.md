# Moving prod's Authentik and portal to the cluster

Step 11 of #231 moves Authentik (`login.cycsail.team`) and the portal (`cycsail.team`) off the
substrate VM and into the cluster's `prod` namespace, together: the portal's `forward_auth` reaches
Authentik by its Service name. Directus stays wherever it runs. It signs in through Authentik's
public URL, so it follows the `login.` record.

| Project          | What changes                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure` | The VM's compose file drops Authentik's server and worker, and its Caddy drops the `login.` and apex sites. `portal-a` leaves its state                                                         |
| `authentik`      | `authentik:onCluster: true`: the server, the worker, their Secrets, the email templates, and the `login.` redirects, on the VM's database and secrets. The `login.` record moves to the Gateway |
| `portal`         | A new prod stack: the image dev built for the same commit, by digest, behind the Gateway, and the apex record, moved in from `infrastructure`                                                   |

Authentik keeps its database and every generated secret, so sessions, users, flows, and the Directus
OIDC client survive. Its secret key and bootstrap token come from the same `RandomBytes` the VM read
through Secret Manager. Prod mail goes through the Workspace SMTP relay from the Cloud NAT's static
address, which the relay already admits (Decision 1).

**Never run two Authentik instances against prod's database.** The VM's Authentik stops in step 6,
before the cluster's starts in step 7. Rollback stops the cluster's before the VM's starts.

## Prerequisites

- The deployer's access: `mise run auth-gcp` and `mise run auth-adc`, `roles/owner` on the project,
  and a place in platform's `bootstrap:humanDeployers`. `infrastructure`'s apply needs the gcloud
  CLI login for its IAP SSH.
- Docker running. `infrastructure` builds the substrate image.
- Nobody else deploying prod. Say so before starting.
- The PR merged, and `main`'s `pull-request` run for the merge commit green. That run deploys the
  commit to dev, which builds the portal image prod runs. A PR's own run builds GitHub's merge ref,
  whose SHA is neither the PR's head nor the commit on `main`, so prod can't use its image.
- A checkout of that commit on `main`, with `mise run install` run. Cut over soon after the merge,
  and run no other prod deploy from `main` in between: `infrastructure` would delete `portal-a` and
  stop the VM's Authentik before anything replaces them.
- A quiet time. Sign-in and the portal are down for about 15 minutes (see [Downtime](#downtime)).
- Every command runs under the workplace's mise env with `PULUMI_STACK=prod`.

## Steps

1. Check the commit, its image, and the Gateway's certificate.

   ```sh
   git status --short   # nothing
   git log -1 --oneline  # the merge commit on main
   gcloud artifacts docker images describe \
     "us-west1-docker.pkg.dev/cyc-admin-scripts/artifact-docker-repository/portal:$(git rev-parse HEAD)" \
     --format='value(image_summary.digest)'
   gcloud certificate-manager certificates list --format='table(name,sanDnsnames,managed.state)'
   ```

   The image has a digest, and the certificate for `cycsail.team` and `*.cycsail.team` is `ACTIVE`.

2. Back up the two stacks the move touches, to a dated directory outside the repo.

   ```sh
   backup=~/pulumi-backups/$(date +%F)-step-11
   mkdir -p "$backup"
   for project in infrastructure authentik; do
     PULUMI_STACK=prod mise exec -- pulumi stack export --stack "organization/$project/prod" --file "$backup/$project.json"
   done
   ```

3. Dry run the move. It should create `organization/portal/prod` and move `portal-a` into it.

   ```sh
   PULUMI_STACK=prod mise exec -- ./scripts/move-portal-state
   ```

4. Apply it. Nothing in the cloud changes.

   ```sh
   PULUMI_STACK=prod mise exec -- ./scripts/move-portal-state --apply
   ```

5. Preview each project and check it against this table. Anything else, stop and roll back the move
   (see [Rolling back the move](#rolling-back-the-move)).

   ```sh
   for project in infrastructure authentik portal; do
     PULUMI_STACK=prod mise exec -- pulumi preview --cwd "packages/infrastructure/src/$project" --stack prod --diff
   done
   ```

   | Project          | Expect                                                                                                                                                                                                                                                            |
   | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `infrastructure` | `~` the three images (`contextHash`), `~ substrate` (`metadata`: the compose file without Authentik), `+- substrate-apply`. No deletes                                                                                                                            |
   | `authentik`      | 15 to create: the Kubernetes provider, the server and worker, two Secrets, the ConfigMap, the redirect route, and `authentik-api-ready`. `~ authentik-a` (`rrdatas` to the Gateway). `~` three Authentik objects whose lookups are unknown until the server is up |
   | `portal`         | The Kubernetes provider, the `portal` WebService, and `portal-ready` to create. `~ portal-a` (`rrdatas` to the Gateway)                                                                                                                                           |

6. Stop the VM's Authentik, and its Caddy's `login.` and apex sites. **Downtime starts.**

   ```sh
   PULUMI_STACK=prod mise exec -- pulumi up --cwd packages/infrastructure/src/infrastructure --stack prod
   ```

   Check that no Authentik container is left on the VM before going on:

   ```sh
   read -r name zone < <(./scripts/substrate-vm)
   gcloud compute ssh "$name" --zone="$zone" --tunnel-through-iap -- docker ps --format '{{.Names}}'
   ```

   It lists `caddy` and `directus` only.

7. Start Authentik on the cluster and move `login.`. The update waits until the API answers at
   `https://login.cycsail.team`, which takes the load balancer a few minutes and DNS up to 5.

   ```sh
   PULUMI_STACK=prod mise exec -- pulumi up --cwd packages/infrastructure/src/authentik --stack prod
   ```

8. Start the portal and move the apex.

   ```sh
   PULUMI_STACK=prod mise exec -- pulumi up --cwd packages/infrastructure/src/portal --stack prod
   ```

9. Verify (below). **Downtime ends** when the sign-in checks pass.

10. Preview all three projects again. Each shows no changes.

## Verification

```sh
kubectl --context gke_cyc-admin-scripts_us-west1_cyc get pods -n prod   # authentik-server, authentik-worker, portal: Running
dig +short login.cycsail.team cycsail.team @8.8.8.8                   # the Gateway's address, twice
curl -sI https://login.cycsail.team/ | grep -i '^location'             # https://cycsail.team/welcome
curl -sI https://login.cycsail.team/if/user/ | grep -i '^location'     # https://cycsail.team/welcome
curl -s -o /dev/null -w '%{http_code}\n' https://cycsail.team/welcome  # 200
curl -sI https://cycsail.team/ | grep -i '^location'                   # .../outpost.goauthentik.io/start?rd=...
# A forged header still gets the sign-in redirect, not the page:
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Authentik-Groups: staff' https://cycsail.team/   # 302
```

Then in a private browser window:

- **Emailed code.** Open `https://cycsail.team`, enter an address you can read, and sign in from the
  email. It comes from `noreply@cyccommunitysailing.org`, through the relay. If it doesn't arrive in
  a minute, read the worker's log for the SMTP error:
  `kubectl --context gke_cyc-admin-scripts_us-west1_cyc logs -n prod deploy/authentik-worker | grep -i -e smtp -e email`.
- **Google.** Sign out, then sign in with the Google button. A staff account sees the staff
  sections.
- **The portal gate.** Signed out, `https://cycsail.team` sends you to sign in.
- **The `login.` redirects.** `https://login.cycsail.team/` lands on the portal's welcome page.
- **Directus SSO.** At `https://directus.cycsail.team`, "Log in with Authentik" lands signed in.

## Downtime

Sign-in, the portal, and Directus's Authentik sign-in are down from step 6 until DNS moves in steps
7 and 8: Authentik's pods start (2 to 3 minutes on an existing database), the load balancer admits
the new routes (up to 10), and the old records expire (TTL 5 minutes). Expect about 15 minutes, and
allow 30. Directus itself, its existing sessions, its admin password sign-in, and both syncs keep
working.

## Rolling back

### Rolling back the move

Before step 6, nothing in the cloud has changed. Restore the backups, and remove the new stack's
state only:

```sh
for project in infrastructure authentik; do
  PULUMI_STACK=prod mise exec -- pulumi stack import --stack "organization/$project/prod" --file "$backup/$project.json"
done
# --force removes the stack's state only. The record stays, owned again by infrastructure.
PULUMI_STACK=prod mise exec -- pulumi stack rm organization/portal/prod --force --yes
```

### Rolling back the cutover

If the cluster's Authentik can't be fixed forward, put the VM back, in this order.

1. Stop the cluster's Authentik, and wait until its pods are gone.

   ```sh
   kubectl --context gke_cyc-admin-scripts_us-west1_cyc scale deployment authentik-server authentik-worker -n prod --replicas=0
   kubectl --context gke_cyc-admin-scripts_us-west1_cyc get pods -n prod
   ```

2. Restore the VM's compose file and Caddyfile from before the merge, and apply `infrastructure`.
   The VM's Authentik starts on the same database. `portal-a` stays in `portal`'s state.

   ```sh
   git checkout HEAD~1 -- packages/substrate/deploy
   PULUMI_STACK=prod mise exec -- pulumi up --cwd packages/infrastructure/src/infrastructure --stack prod
   ```

3. Point both records back at the VM by hand. The `authentik` project's own lookups need a reachable
   Authentik, so its update must come after DNS has moved.

   ```sh
   vm=$(gcloud compute addresses list --filter='name~^substrate' --format='value(address)')
   zone=$(gcloud dns managed-zones list --filter='dnsName=cycsail.team.' --format='value(name)')
   for host in login.cycsail.team. cycsail.team.; do
     gcloud dns record-sets update "$host" --type=A --ttl=300 --zone="$zone" --rrdatas="$vm"
   done
   ```

4. After 5 minutes, set `authentik:onCluster: false` in `authentik/Pulumi.prod.yaml` and
   `portal:onCluster: false` in `portal/Pulumi.prod.yaml`, and apply both. They delete their
   Kubernetes resources and record the VM's address.

   ```sh
   for project in authentik portal; do
     PULUMI_STACK=prod mise exec -- pulumi up --cwd "packages/infrastructure/src/$project" --stack prod
   done
   ```

5. Run the [verification](#verification) against the VM, and record what failed on #231. A
   revert of the PR on `main` then matches what runs.

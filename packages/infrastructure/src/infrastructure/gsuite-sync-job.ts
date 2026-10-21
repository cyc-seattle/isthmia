import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRegistryApi } from "./artifact-repository";
import { artifactRepositoryUrl } from "./cloud";
import { location, projectId } from "../config";
import { gsuiteSyncRunner } from "./identities";
import { directusBaseUrl } from "./directus";
import { secretAccessor } from "../secret";
import { enableService } from "../services";

// The break-glass super-admins granted OWNER on every group. `commander@` joins once #81 lands.
// Set in stack config rather than defaulted in the job's own source: ownership is a security
// boundary, so the deployed value should be visible in the infrastructure that grants it.
const groupOwners = new pulumi.Config().require("groupOwners");

// The Workspace customer to read groups from. Not `my_customer`: that alias resolves against the
// authenticated *user's* domain, and this job holds a Groups Administrator role assignment rather
// than impersonating a domain user, so it belongs to no domain and the alias 404s. Matches the GCP
// organization's `owner.directoryCustomerId`.
const workspaceCustomer = new pulumi.Config().require("workspaceCustomer");

const runApi = enableService("run.googleapis.com");
const schedulerApi = enableService("cloudscheduler.googleapis.com");

// The Directus token is `crm`'s, and the runtime APIs `gsuite-sync`'s (#231).
secretAccessor("gsuite-sync-directus-token", gsuiteSyncRunner.member, "gsuite-sync-runner", projectId);

const imageName = "gsuite-sync:latest";
const imageTag = pulumi.concat(artifactRepositoryUrl, "/", imageName);

const gsuiteSyncImage = new docker.Image(
  "gsuite-sync-image",
  {
    tags: [imageTag],
    context: {
      location: "../../../..",
    },
    target: "gsuite-sync",
    platforms: ["linux/amd64"],
    push: true,
    // Defaults to true: every `mise run preview` would otherwise build the image (#114).
    buildOnPreview: false,
    registries: [
      {
        address: `${location}-docker.pkg.dev`,
        username: "oauth2accesstoken",
        password: gcp.organizations.getClientConfigOutput({}).accessToken,
      },
    ],
  },
  { dependsOn: artifactRegistryApi },
);

const gsuiteSyncJob = new gcp.cloudrunv2.Job(
  "gsuite-sync-job",
  {
    name: "gsuite-sync-job",
    location,
    deletionProtection: false,
    template: {
      // Not just a resource default: the queue's task claiming (packages/directus/src/queue.ts) is
      // a plain read-then-update with no lease, which is only safe with a single worker touching
      // the queue at a time.
      parallelism: 1,
      template: {
        // Same 3600s as clubspot-sync-job.ts, and for the same reason: enough headroom for a cold
        // sync, capped so it can't outlast the hourly scheduler below.
        timeout: "3600s",
        serviceAccount: gsuiteSyncRunner.email,
        containers: [
          {
            image: imageTag,
            resources: {
              // Same as clubspot-sync-job.ts: an omitted CPU limit shows as a diff on every deploy.
              limits: {
                cpu: "1000m",
                memory: "1Gi",
              },
            },
            envs: [
              {
                name: "DIRECTUS_URL",
                value: directusBaseUrl,
              },
              {
                name: "DIRECTUS_TOKEN",
                valueSource: {
                  secretKeyRef: {
                    secret: "gsuite-sync-directus-token",
                    version: "latest",
                  },
                },
              },
              {
                name: "GSUITE_SYNC_GROUP_OWNERS",
                value: groupOwners,
              },
              {
                name: "GSUITE_SYNC_CUSTOMER",
                value: workspaceCustomer,
              },
            ],
          },
        ],
      },
    },
  },
  // Same missing edge as clubspot-sync-job.ts: the job's `image` is a plain string, so nothing
  // else tells Pulumi it needs the image pushed first.
  { dependsOn: [runApi, gsuiteSyncImage] },
);

new gcp.cloudrunv2.JobIamMember("gsuite-sync-job-runner-invoker", {
  project: projectId,
  name: gsuiteSyncJob.name,
  location,
  role: "roles/run.invoker",
  member: gsuiteSyncRunner.member,
});

const jobRunUrl = pulumi.interpolate`https://${location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${gsuiteSyncJob.name}:run`;

// Hourly, same cadence as clubspot-sync-hourly - the queue makes each run pick up only what's due,
// so there's no cost to checking more often than anything actually changes.
new gcp.cloudscheduler.Job(
  "gsuite-sync-hourly",
  {
    name: "gsuite-sync-hourly",
    description: "Triggers the gsuite-sync job hourly",
    schedule: "0 * * * *",
    timeZone: "PST",
    region: location,
    httpTarget: {
      httpMethod: "POST",
      uri: jobRunUrl,
      oauthToken: {
        serviceAccountEmail: gsuiteSyncRunner.email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      },
    },
  },
  { dependsOn: schedulerApi },
);

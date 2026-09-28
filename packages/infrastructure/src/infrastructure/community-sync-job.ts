import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "../config";
import { communitySyncRunner } from "./identities";
import { directusBaseUrl, communitySyncDirectusToken } from "./directus";
import { internalDomain } from "./dns";
import { enableService } from "../services";

// The Google Group the staff pass mirrors into Authentik's staff group.
const staffSourceGroup = new pulumi.Config().get("communitySyncStaffGroup") ?? "all@cyccommunitysailing.org";

// The family pass stays off until the board approves sharing names and contact information (see
// the design's "Launch prerequisite"). Setting this later needs no image rebuild: main.ts reads
// it from COMMUNITY_SYNC_FAMILIES, a boolean commander flag that a merely-defined env var enables.
const enableFamilyPass = new pulumi.Config().getBoolean("communitySyncFamilies") ?? false;

const runApi = enableService("run.googleapis.com");
const schedulerApi = enableService("cloudscheduler.googleapis.com");
const runtimeApi = enableService("admin.googleapis.com");

communitySyncDirectusToken.secret.grant(communitySyncRunner.member, "community-sync-runner");

// The Authentik API token's secret container is declared in ../authentik (its value only exists
// once Authentik generates it) - granted here, by literal secret id, since this is where the job's
// service account is actually stood up. `deleteBeforeReplace` matches Secret.grant (../secret.ts):
// a SecretIamMember is read-modify-write against one shared IAM policy.
new gcp.secretmanager.SecretIamMember(
  "secret-accessor-community-sync-authentik-token-community-sync-runner",
  {
    secretId: "community-sync-authentik-token",
    project: projectId,
    role: "roles/secretmanager.secretAccessor",
    member: communitySyncRunner.member,
  },
  { deleteBeforeReplace: true },
);

const imageName = "community-sync:latest";
const imageTag = pulumi.concat(artifactRepositoryUrl, "/", imageName);

const communitySyncImage = new docker.Image(
  "community-sync-image",
  {
    tags: [imageTag],
    context: {
      location: "../../../..",
    },
    target: "community-sync",
    platforms: ["linux/amd64"],
    push: true,
    // Defaults to true: every `just preview` would otherwise build the image (#114).
    buildOnPreview: false,
    registries: [
      {
        address: `${location}-docker.pkg.dev`,
        username: "oauth2accesstoken",
        password: gcp.organizations.getClientConfigOutput({}).accessToken,
      },
    ],
  },
  { dependsOn: artifactRepositoryAccess },
);

const communitySyncJob = new gcp.cloudrunv2.Job(
  "community-sync-job",
  {
    name: "community-sync-job",
    location,
    deletionProtection: false,
    template: {
      parallelism: 1,
      template: {
        // Same 3600s as clubspot-sync-job.ts and gsuite-sync-job.ts: enough headroom for a cold
        // sync, capped so it can't outlast the hourly scheduler below.
        timeout: "3600s",
        serviceAccount: communitySyncRunner.email,
        containers: [
          {
            image: imageTag,
            resources: {
              limits: {
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
                    secret: "community-sync-directus-token",
                    version: "latest",
                  },
                },
              },
              {
                name: "AUTHENTIK_URL",
                value: pulumi.interpolate`https://login.${internalDomain}`,
              },
              {
                name: "AUTHENTIK_TOKEN",
                valueSource: {
                  secretKeyRef: {
                    secret: "community-sync-authentik-token",
                    version: "latest",
                  },
                },
              },
              {
                name: "COMMUNITY_SYNC_STAFF_GROUP",
                value: staffSourceGroup,
              },
              // Set (to any value) only once the board approves the family pass - see
              // enableFamilyPass above.
              ...(enableFamilyPass ? [{ name: "COMMUNITY_SYNC_FAMILIES", value: "true" }] : []),
            ],
          },
        ],
      },
    },
  },
  // Same missing edge as clubspot-sync-job.ts and gsuite-sync-job.ts: the job's `image` is a plain
  // string, so nothing else tells Pulumi it needs the image pushed first.
  { dependsOn: [runApi, runtimeApi, communitySyncImage] },
);

new gcp.cloudrunv2.JobIamMember("community-sync-job-runner-invoker", {
  project: projectId,
  name: communitySyncJob.name,
  location,
  role: "roles/run.invoker",
  member: communitySyncRunner.member,
});

const jobRunUrl = pulumi.interpolate`https://${location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${communitySyncJob.name}:run`;

// Hourly, same cadence as clubspot-sync-hourly and gsuite-sync-hourly - the sync is cheap to check
// even when nothing changed.
new gcp.cloudscheduler.Job(
  "community-sync-hourly",
  {
    name: "community-sync-hourly",
    description: "Triggers the community-sync job hourly",
    schedule: "0 * * * *",
    timeZone: "PST",
    region: location,
    httpTarget: {
      httpMethod: "POST",
      uri: jobRunUrl,
      oauthToken: {
        serviceAccountEmail: communitySyncRunner.email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      },
    },
  },
  { dependsOn: schedulerApi },
);

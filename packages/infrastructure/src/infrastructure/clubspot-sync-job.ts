import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRegistryApi } from "./artifact-repository";
import { artifactRepositoryUrl } from "./cloud";
import { location, projectId } from "../config";
import { clubspotSyncRunner } from "./identities";
import { directusBaseUrl, clubspotSyncDirectusToken } from "./directus";
import { Secret } from "./secret";
import { enableService } from "../services";

// The one CYC club this job syncs. No sensible default, unlike substrateMachineType or
// directusAdminEmail above - required so a stack that forgets to set it fails at `pulumi up`
// instead of deploying a job that syncs nothing.
const clubspotClubId = new pulumi.Config().require("clubspotClubId");

const runApi = enableService("run.googleapis.com");
const schedulerApi = enableService("cloudscheduler.googleapis.com");
const secretmanagerApi = enableService("secretmanager.googleapis.com");

const clubspotCredentialSecrets = {
  "clubspot-username": new Secret("clubspot-username", { dependsOn: secretmanagerApi }),
  "clubspot-password": new Secret("clubspot-password", { dependsOn: secretmanagerApi }),
};
for (const secret of Object.values(clubspotCredentialSecrets)) {
  secret.grant(clubspotSyncRunner.member, "clubspot-sync-runner");
}
clubspotSyncDirectusToken.secret.grant(clubspotSyncRunner.member, "clubspot-sync-runner");

const imageName = "clubspot-sync:latest";
const imageTag = pulumi.concat(artifactRepositoryUrl, "/", imageName);

const clubspotSyncImage = new docker.Image(
  "clubspot-sync-image",
  {
    tags: [imageTag],
    context: {
      location: "../../../..",
    },
    target: "clubspot-sync",
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

const clubspotSyncJob = new gcp.cloudrunv2.Job(
  "clubspot-sync-job",
  {
    name: "clubspot-sync-job",
    location,
    deletionProtection: false,
    template: {
      parallelism: 1,
      template: {
        // Default 600s isn't enough for a cold sync of every camp (#143 finding: 2 of 40 done
        // before the kill). An hour matches the scheduler's own cadence below, so one run's timeout
        // can't overlap the next trigger.
        timeout: "3600s",
        serviceAccount: clubspotSyncRunner.email,
        containers: [
          {
            image: imageTag,
            resources: {
              // Cloud Run's default CPU, set explicitly because the API returns it and an omitted
              // value shows as a diff on every deploy.
              limits: {
                cpu: "1000m",
                memory: "1Gi",
              },
            },
            envs: [
              {
                name: "CLUBSPOT_CLUB_ID",
                value: clubspotClubId,
              },
              {
                name: "DIRECTUS_URL",
                value: directusBaseUrl,
              },
              {
                name: "CLUBSPOT_EMAIL",
                valueSource: {
                  secretKeyRef: {
                    secret: "clubspot-username",
                    version: "latest",
                  },
                },
              },
              {
                name: "CLUBSPOT_PASSWORD",
                valueSource: {
                  secretKeyRef: {
                    secret: "clubspot-password",
                    version: "latest",
                  },
                },
              },
              {
                name: "DIRECTUS_TOKEN",
                valueSource: {
                  secretKeyRef: {
                    secret: "clubspot-sync-directus-token",
                    version: "latest",
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  // The job's `image` is a plain string, so nothing tells Pulumi it needs the image pushed first.
  // Without this edge the job is created against a tag that does not exist yet and Cloud Run rejects
  // it with "Image not found".
  { dependsOn: [runApi, clubspotSyncImage] },
);

new gcp.cloudrunv2.JobIamMember("clubspot-sync-job-runner-invoker", {
  project: projectId,
  name: clubspotSyncJob.name,
  location,
  role: "roles/run.invoker",
  member: clubspotSyncRunner.member,
});

const jobRunUrl = pulumi.interpolate`https://${location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${clubspotSyncJob.name}:run`;

// Hourly matches BASE_INTERVAL_MS in backoff.ts, so a camp that just wrote something is due again
// on the very next run.
new gcp.cloudscheduler.Job(
  "clubspot-sync-hourly",
  {
    name: "clubspot-sync-hourly",
    description: "Triggers the clubspot-sync job hourly",
    schedule: "0 * * * *",
    timeZone: "PST",
    region: location,
    httpTarget: {
      httpMethod: "POST",
      uri: jobRunUrl,
      oauthToken: {
        serviceAccountEmail: clubspotSyncRunner.email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      },
    },
  },
  { dependsOn: schedulerApi },
);

import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "../config";
import { clubspotSyncRunner } from "./identities";
import { directusBaseUrl, clubspotSyncDirectusToken } from "./directus";
import { secrets as clubspotCredentialSecrets } from "./run-reports-job";
import { enableService } from "../services";

// The one CYC club this job syncs. No sensible default, unlike substrateMachineType or
// directusAdminEmail above - required so a stack that forgets to set it fails at `pulumi up`
// instead of deploying a job that syncs nothing.
const clubspotClubId = new pulumi.Config().require("clubspotClubId");

const runApi = enableService("run.googleapis.com");
const schedulerApi = enableService("cloudscheduler.googleapis.com");

// The Clubspot credentials already exist (declared in run-reports-job.ts) - grant this job's
// service account access rather than creating a second copy of the same secrets.
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

const clubspotSyncJob = new gcp.cloudrunv2.Job(
  "clubspot-sync-job",
  {
    name: "clubspot-sync-job",
    location,
    deletionProtection: false,
    template: {
      parallelism: 1,
      template: {
        serviceAccount: clubspotSyncRunner.email,
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

// Every six hours: well under the 24-hour refresh floor (change-detection.ts), so a camp with no
// counted changes still gets a fresh full sync every fourth run at worst, while a camp that did
// change is picked up the same day it happens rather than waiting for a daily job.
new gcp.cloudscheduler.Job(
  "clubspot-sync-every-six-hours",
  {
    name: "clubspot-sync-every-six-hours",
    description: "Triggers the clubspot-sync job every six hours",
    schedule: "0 */6 * * *",
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

import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { deployers, location, projectId, reportRunners } from "./config";
import { Secret } from "./secret";
import { ServiceAccount } from "./service-account";

// Create service account for the Cloud Run function
const reportRunner = new ServiceAccount("report-runner", "Service account that runs the run-reports job.");

reportRunner.allowImpersonation(reportRunners);

const secrets = {
  "clubspot-username": new Secret("clubspot-username"),
  "clubspot-password": new Secret("clubspot-password"),
};

// Grant the service account access to read secrets.
for (const secret of Object.values(secrets)) {
  secret.grant(reportRunner.member);
}

const imageName = "report-runner:latest";
const imageTag = pulumi.concat(artifactRepositoryUrl, "/", imageName);

// Authenticate the image push using an OAuth2 access token from the credentials
// pulumi is running as, rather than relying on a docker credential helper (which
// is awkward when building through podman, whose auth config lives elsewhere).
const registryAddress = `${location}-docker.pkg.dev`;
const registryToken = gcp.organizations.getClientConfig({}).then((config) => config.accessToken);

new docker.Image(
  "report-runner-image",
  {
    tags: [imageTag],
    context: {
      location: "../..",
    },
    platforms: ["linux/amd64"],
    push: true,
    registries: [
      {
        address: registryAddress,
        username: "oauth2accesstoken",
        password: registryToken,
      },
    ],
  },
  {
    // Explicitly depend on the authorization being created to allow the user who is probably running
    // pulumi up to actually push images to the created artifact repository.
    dependsOn: artifactRepositoryAccess,
  },
);

const runReportsJob = new gcp.cloudrunv2.Job("run-reports-job", {
  name: "run-reports-job",
  location,
  deletionProtection: false,
  template: {
    parallelism: 1,
    template: {
      serviceAccount: reportRunner.email,
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
              name: "CONFIG_SPREADSHEET_ID",
              value: "1h9QxQk_123cMWljmcHPudpOkCIqZyA0xYHLJLpZN_3k",
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
          ],
        },
      ],
    },
  },
});

new gcp.cloudrunv2.JobIamMember("job-runner-invoker", {
  project: projectId,
  name: runReportsJob.name,
  location,
  role: "roles/run.invoker",
  member: reportRunner.member,
});

for (const deployer of deployers) {
  new gcp.projects.IAMMember(`run-developer-${deployer}`, {
    project: projectId,
    role: "roles/run.developer",
    member: deployer,
  });
}

const jobRunUrl = pulumi.interpolate`https://${location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${runReportsJob.name}:run`;

new gcp.cloudscheduler.Job("run-reports-hourly", {
  name: "run-reports-hourly",
  description: "Triggers the run-reports job every hour between 9AM PST and 9PM PST",
  schedule: "0 9-21 * * *",
  timeZone: "PST",
  region: location,
  httpTarget: {
    httpMethod: "POST",
    uri: jobRunUrl,
    oauthToken: {
      serviceAccountEmail: reportRunner.email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    },
  },
});

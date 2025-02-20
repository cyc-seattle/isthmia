import * as docker from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import {
  artifactRepositoryAccess,
  artifactRepositoryUrl,
} from './artifact-repository';
import { location, projectId, reportRunners } from './config';

// Create service account for the Cloud Run function
const jobRunner = new gcp.serviceaccount.Account('report-runner', {
  accountId: 'report-runner',
  displayName: 'Service account that runs the run-reports job.',
});

const jobRunnerMember = pulumi.interpolate`serviceAccount:${jobRunner.email}`;

for (const reportRunner of reportRunners) {
  // Allow running operations as a service account.
  new gcp.serviceaccount.IAMMember(`${reportRunner}-user`, {
    serviceAccountId: jobRunner.name,
    role: 'roles/iam.serviceAccountUser',
    member: reportRunner,
  });

  // Allow impersonating a service account.
  new gcp.serviceaccount.IAMMember(`${reportRunner}-impersonator`, {
    serviceAccountId: jobRunner.name,
    role: 'roles/iam.serviceAccountTokenCreator',
    member: reportRunner,
  });
}

function makeSecret(secretName: string) {
  return new gcp.secretmanager.Secret(secretName, {
    secretId: secretName,
    replication: {
      auto: {},
    },
  });
}

const secrets = {
  'clubspot-username': makeSecret('clubspot-username'),
  'clubspot-password': makeSecret('clubspot-password'),
};

// Grant the service account access to read secrets.
for (const [name, secret] of Object.entries(secrets)) {
  new gcp.secretmanager.SecretIamMember(`secret-accessor-${name}`, {
    secretId: secret.secretId,
    project: secret.project,
    role: 'roles/secretmanager.secretAccessor',
    member: jobRunnerMember,
  });
}

const imageName = 'report-runner:latest';
const imageTag = pulumi.concat(artifactRepositoryUrl, '/', imageName);

new docker.Image(
  'report-runner-image',
  {
    tags: [imageTag],
    context: {
      location: '../..',
    },
    platforms: ['linux/amd64'],
    push: true,
  },
  {
    // Explicitly depend on the authorization being created to allow the user who is probably running
    // pulumi up to actually push images to the created artifact repository.
    dependsOn: artifactRepositoryAccess,
  },
);

const runReportsJob = new gcp.cloudrunv2.Job('run-reports-job', {
  name: 'run-reports-job',
  location,
  deletionProtection: false,
  template: {
    parallelism: 1,
    template: {
      serviceAccount: pulumi.interpolate`${jobRunner.email}`,
      containers: [
        {
          image: imageTag,
          envs: [
            {
              name: 'CONFIG_SPREADSHEET_ID',
              value: '1h9QxQk_123cMWljmcHPudpOkCIqZyA0xYHLJLpZN_3k',
            },
            {
              name: 'CLUBSPOT_EMAIL',
              valueSource: {
                secretKeyRef: {
                  secret: 'clubspot-username',
                  version: 'latest',
                },
              },
            },
            {
              name: 'CLUBSPOT_PASSWORD',
              valueSource: {
                secretKeyRef: {
                  secret: 'clubspot-password',
                  version: 'latest',
                },
              },
            },
          ],
        },
      ],
    },
  },
});

new gcp.cloudrunv2.JobIamMember('job-runner-invoker', {
  project: projectId,
  name: runReportsJob.name,
  location,
  role: 'roles/run.invoker',
  member: jobRunnerMember,
});

const jobRunUrl = pulumi.interpolate`https://${location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${runReportsJob.name}:run`;

new gcp.cloudscheduler.Job('run-reports-hourly', {
  name: 'run-reports-hourly',
  description: 'Triggers the run-reports job every hour.',
  schedule: '0 * * * *',
  timeZone: 'UTC',
  region: location,
  httpTarget: {
    httpMethod: 'POST',
    uri: jobRunUrl,
    oauthToken: {
      serviceAccountEmail: jobRunner.email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    },
  },
});

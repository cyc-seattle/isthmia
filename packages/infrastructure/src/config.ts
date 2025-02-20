import * as gcp from '@pulumi/gcp';

export const location = gcp.config.region ?? 'us-west1';
export const projectId = gcp.config.project ?? 'cyc-admin-scripts';

// Users who are allowed to impersonate the report runner
export const reportRunners = [
  'user:master@cyccommunitysailing.org',
  'user:ungood@onetrue.name',
];

// Users who are allowed to deploy this app
export const deployers = [
  'user:master@cyccommunitysailing.org',
  'user:ungood@onetrue.name',
];

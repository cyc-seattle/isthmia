import * as gcp from "@pulumi/gcp";

export const location = gcp.config.region ?? "us-west1";
export const projectId = gcp.config.project ?? "cyc-admin-scripts";

// Users who are allowed to impersonate the report runner
export const reportRunners = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

// Users who are allowed to deploy this app
export const deployers = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

// NOTE: This list is probably not comprehensive, because I enabled some through the UI before discovering I can do
// it with pulumi
const enabledServices = ["admin.googleapis.com"];

for (const service of enabledServices) {
  new gcp.projects.Service(`enable-${service}`, { service });
}

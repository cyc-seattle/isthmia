import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

export const location = gcp.config.region ?? "us-west1";
export const projectId = gcp.config.project ?? "cyc-admin-scripts";

// Users who are allowed to impersonate the report runner
export const reportRunners = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

// Users who are allowed to deploy this app
export const deployers = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

const config = new pulumi.Config();

// The apex domain the self-hosted platform serves from. Each surface gets a subdomain
// (crm., coach., guardian., …) in the networking slice (#77). Set with:
//   pulumi config set platformDomain <domain>
export const platformDomain = config.get("platformDomain") ?? "example.org";

// Compute Engine machine type for the single platform VM (Tier B). Start at e2-medium (4 GB) and
// resize to e2-standard-2 (8 GB) when load requires it — resizing is a reboot, not a rebuild.
export const platformMachineType = config.get("platformMachineType") ?? "e2-medium";

// NOTE: This list is probably not comprehensive, because I enabled some through the UI before discovering I can do
// it with pulumi
const enabledServices = [
  "admin.googleapis.com",
  // The reports read/write Google Sheets and the roster generator creates spreadsheets in
  // a Drive folder, so both APIs must be enabled on the project.
  "sheets.googleapis.com",
  "drive.googleapis.com",
  // Self-hosted platform foundation (#64): Secret Manager for credentials, Cloud SQL for the
  // people hub, Compute + Cloud DNS for the VM and its subdomains, Monitoring/uptime, and Cloud
  // Storage for backups.
  "secretmanager.googleapis.com",
  "sqladmin.googleapis.com",
  "compute.googleapis.com",
  "dns.googleapis.com",
  "monitoring.googleapis.com",
  "storage.googleapis.com",
];

for (const service of enabledServices) {
  new gcp.projects.Service(`enable-${service}`, { service });
}

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

export const location = gcp.config.region ?? "us-west1";

// Safe (non-prod) default. The production project is set per-stack via `gcp:project` in
// Pulumi.prod.yaml, so a stack that forgets to configure it fails safely instead of silently
// targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

// Users who are allowed to impersonate the report runner
export const reportRunners = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

// Users who are allowed to deploy this app
export const deployers = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

const config = new pulumi.Config();

// Domains the platform serves from. Safe (example) defaults live here; the real production domains
// are set per-stack in Pulumi.prod.yaml, so a non-prod stack never touches real DNS.
//   externalDomain — public-facing website
//   internalDomain — admin / staff / volunteer portals
//   shortDomain    — link shortener
export const externalDomain = config.get("externalDomain") ?? "external.example.com";
export const internalDomain = config.get("internalDomain") ?? "internal.example.com";
export const shortDomain = config.get("shortDomain") ?? "short.example.com";

// Compute Engine machine type for the platform VM (Tier B floor). Resize to e2-standard-2 when
// load requires it — a reboot, not a rebuild.
export const platformMachineType = config.get("platformMachineType") ?? "e2-medium";

// NOTE: This list is probably not comprehensive, because I enabled some through the UI before discovering I can do
// it with pulumi
const enabledServices = [
  "admin.googleapis.com",
  // The reports read/write Google Sheets and the roster generator creates spreadsheets in
  // a Drive folder, so both APIs must be enabled on the project.
  "sheets.googleapis.com",
  "drive.googleapis.com",
  // Platform Cloud SQL (#76): the database itself, plus Compute + Service Networking for the VPC
  // and the private-IP peering the instance requires.
  "sqladmin.googleapis.com",
  "compute.googleapis.com",
  "servicenetworking.googleapis.com",
  // Platform DNS (#77): Cloud DNS managed zones for the platform domains.
  "dns.googleapis.com",
  // Platform VM (#78): OS Login + IAP so SSH is brokered through IAP instead of a public port.
  "oslogin.googleapis.com",
  "iap.googleapis.com",
];

for (const service of enabledServices) {
  new gcp.projects.Service(`enable-${service}`, { service });
}

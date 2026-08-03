import * as gcp from "@pulumi/gcp";

// Cross-cutting values used across the package. Configuration used by only one file lives in that
// file (e.g. domains in dns.ts, the VM machine type in compute.ts).

export const location = gcp.config.region ?? "us-west1";

// Safe (non-prod) default. The production project is set per-stack via `gcp:project` in
// Pulumi.prod.yaml, so a stack that forgets to configure it fails safely instead of silently
// targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

// Users who are allowed to deploy this app.
export const deployers = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

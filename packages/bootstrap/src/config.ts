import * as gcp from "@pulumi/gcp";

// Safe (non-prod) default. The production project is set per-stack via `gcp:project` in
// Pulumi.prod.yaml, so a stack that forgets to configure it fails safely instead of silently
// targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

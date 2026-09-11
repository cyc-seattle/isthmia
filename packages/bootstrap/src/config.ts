import * as gcp from "@pulumi/gcp";

// Safe (non-prod) default. The production project is set per-stack via `gcp:project` in
// Pulumi.prod.yaml, so a stack that forgets to configure it fails safely instead of silently
// targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

// deploy-runner already holds compute.osLogin, iap.tunnelResourceAccessor, and run.developer
// through its predefined-role list (deploy-runner.ts), so the only principal these grants still
// need to name explicitly is the human operator. OS Login is demonstrably not covered by project
// Owner for a principal outside the organization (see docs/manual-setup.md), so dropping this would
// break `just ssh`, `just logs`, `just db-tunnel`, and every deploy run as `ungood@`.
export const humanDeployer = "user:ungood@onetrue.name";

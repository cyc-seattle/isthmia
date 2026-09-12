import * as gcp from "@pulumi/gcp";

// Cross-cutting values used across the package. Configuration used by only one file lives in that
// file (e.g. domains in dns.ts, the VM machine type in compute.ts).

export const location = gcp.config.region ?? "us-west1";

// Safe (non-prod) default. The production project is set per-stack via `gcp:project` in
// Pulumi.prod.yaml, so a stack that forgets to configure it fails safely instead of silently
// targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

// Principals granted resource-scoped deploy access (currently just artifact-repository.ts). Human
// deployers get access through project `roles/owner` instead (docs/manual-setup.md §7).
export const deployers = ["serviceAccount:deploy-runner@cyc-admin-scripts.iam.gserviceaccount.com"];

// Project Owner doesn't cover OS Login for a principal outside the org (docs/manual-setup.md §7),
// so the human deployer needs these grants explicitly even though deploy-runner already has them.
export const humanDeployer = "user:ungood@onetrue.name";

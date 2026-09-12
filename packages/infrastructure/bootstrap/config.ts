import * as gcp from "@pulumi/gcp";

// Non-prod default; prod sets `gcp:project` per-stack in Pulumi.prod.yaml, so a stack that
// forgets to configure it fails safely instead of silently targeting production.
export const projectId = gcp.config.project ?? "cyc-admin-scripts-dev";

// Project Owner doesn't cover OS Login for a principal outside the org (docs/manual-setup.md §7),
// so the human deployer needs these grants explicitly even though deploy-runner already has them.
export const humanDeployer = "user:ungood@onetrue.name";

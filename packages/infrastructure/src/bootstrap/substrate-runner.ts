import * as gcp from "@pulumi/gcp";
import { humanDeployer, projectId } from "../config";
import { ServiceAccount } from "../service-account";
import { enableService } from "../services";

// Identity the substrate VM and its containers act as. Imported, not recreated — a new client ID
// would break domain-wide delegation for portal auth (docs/manual-setup.md §5.2). App-specific
// grants live in the slices that deploy those apps; this covers only what the host itself needs.
export const substrateRunner = new ServiceAccount(
  "substrate-runner",
  "Service account for the substrate VM and its containers.",
);

// Host-level observability: let the VM ship logs and metrics to Cloud Monitoring/Logging.
for (const role of ["roles/logging.logWriter", "roles/monitoring.metricWriter"]) {
  new gcp.projects.IAMMember(`substrate-runner-${role.replace("roles/", "")}`, {
    project: projectId,
    role,
    member: substrateRunner.member,
  });
}

const iapApi = enableService("iap.googleapis.com");

// Let the human operator reach the VM over IAP-brokered SSH (no public SSH port). deploy-runner
// already holds both roles through its predefined-role list.
for (const role of ["roles/iap.tunnelResourceAccessor", "roles/compute.osLogin"]) {
  new gcp.projects.IAMMember(
    `substrate-ssh-${role.replace("roles/", "")}-${humanDeployer}`,
    { project: projectId, role, member: humanDeployer },
    { dependsOn: iapApi },
  );
}

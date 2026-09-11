import * as gcp from "@pulumi/gcp";
import { humanDeployer, projectId } from "./config";
import { ServiceAccount } from "./service-account";

// Identity the substrate VM (and the containers it runs) act as. App-specific grants — Cloud SQL
// client, Secret Manager access — are added in the slices that deploy the apps that need them; this
// covers only what the host itself needs. Its numeric client ID authorizes domain-wide delegation
// (docs/manual-setup.md §5.2), so this account was imported from packages/infrastructure, not
// recreated — a new account would silently break portal auth.
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

const iapApi = new gcp.projects.Service("enable-iap.googleapis.com", {
  service: "iap.googleapis.com",
  disableOnDestroy: false,
});

// Let the human operator reach the VM over IAP-brokered SSH (no public SSH port). deploy-runner
// already holds both roles through its predefined-role list.
for (const role of ["roles/iap.tunnelResourceAccessor", "roles/compute.osLogin"]) {
  new gcp.projects.IAMMember(
    `substrate-ssh-${role.replace("roles/", "")}-${humanDeployer}`,
    { project: projectId, role, member: humanDeployer },
    { dependsOn: iapApi },
  );
}

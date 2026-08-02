import * as gcp from "@pulumi/gcp";
import { deployers, location, platformMachineType, projectId } from "./config";
import { network, platformTag, subnet } from "./network";
import { ServiceAccount } from "./service-account";

// Identity the platform VM (and the containers it runs) act as. App-specific grants — Cloud SQL
// client, Secret Manager access — are added in the slices that deploy the apps that need them; this
// covers only what the host itself needs.
const platformRunner = new ServiceAccount("platform-runner", "Service account for the platform VM and its containers.");

// Host-level observability: let the VM ship logs and metrics to Cloud Monitoring/Logging.
for (const role of ["roles/logging.logWriter", "roles/monitoring.metricWriter"]) {
  new gcp.projects.IAMMember(`platform-runner-${role.replace("roles/", "")}`, {
    project: projectId,
    role,
    member: platformRunner.member,
  });
}

// Let deployers reach the VM over IAP-brokered SSH (no public SSH port).
for (const deployer of deployers) {
  for (const role of ["roles/iap.tunnelResourceAccessor", "roles/compute.osLogin"]) {
    new gcp.projects.IAMMember(`platform-ssh-${role.replace("roles/", "")}-${deployer}`, {
      project: projectId,
      role,
      member: deployer,
    });
  }
}

// Stable external address for the VM, so DNS can point at it and survive VM replacement.
export const address = new gcp.compute.Address("platform", {
  region: location,
  addressType: "EXTERNAL",
});

// The platform host: Container-Optimized OS, running the app containers behind Caddy + oauth2-proxy.
// The compose stack (Caddy, oauth2-proxy, and the apps themselves) is deployed in the app slices;
// this stands up a ready container host. DNS A records are added when a surface actually serves.
export const instance = new gcp.compute.Instance(
  "platform",
  {
    machineType: platformMachineType,
    zone: `${location}-a`,
    tags: [platformTag],
    bootDisk: {
      initializeParams: {
        image: "cos-cloud/cos-stable",
        size: 30,
        type: "pd-balanced",
      },
    },
    networkInterfaces: [
      {
        subnetwork: subnet.id,
        accessConfigs: [{ natIp: address.address }],
      },
    ],
    serviceAccount: {
      email: platformRunner.email,
      scopes: ["cloud-platform"],
    },
    // OS Login ties SSH access to IAM (the grants above) instead of managing keys by hand.
    metadata: { "enable-oslogin": "TRUE" },
    // Allow machine-type resize (e2-medium -> e2-standard-2) without recreating the VM.
    allowStoppingForUpdate: true,
  },
  { dependsOn: network },
);

export const publicIp = address.address;

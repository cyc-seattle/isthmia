import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { deployers, location, projectId } from "./config";
import { network, subnet, substrateTag } from "./network";
import { substrateUserData } from "./substrate-bootstrap";
import { enableService } from "./services";
import { ServiceAccount } from "./service-account";

// Machine type for the substrate VM (Tier B floor). Resize to e2-standard-2 when load requires it —
// a reboot, not a rebuild.
const machineType = new pulumi.Config().get("substrateMachineType") ?? "e2-medium";

const computeApi = enableService("compute.googleapis.com");
const osLoginApi = enableService("oslogin.googleapis.com");
const iapApi = enableService("iap.googleapis.com");

// Identity the substrate VM (and the containers it runs) act as. App-specific grants — Cloud SQL
// client, Secret Manager access — are added in the slices that deploy the apps that need them; this
// covers only what the host itself needs.
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

// Let deployers reach the VM over IAP-brokered SSH (no public SSH port).
for (const deployer of deployers) {
  for (const role of ["roles/iap.tunnelResourceAccessor", "roles/compute.osLogin"]) {
    new gcp.projects.IAMMember(
      `substrate-ssh-${role.replace("roles/", "")}-${deployer}`,
      {
        project: projectId,
        role,
        member: deployer,
      },
      { dependsOn: iapApi },
    );
  }
}

// Stable external address for the VM, so DNS can point at it and survive VM replacement.
export const address = new gcp.compute.Address("substrate", {
  region: location,
  addressType: "EXTERNAL",
});

// The substrate host: Container-Optimized OS, running the app containers behind Caddy + oauth2-proxy.
// The compose stack (Caddy, oauth2-proxy, and the apps themselves) is deployed in the app slices;
// this stands up a ready container host. DNS A records are added when a surface actually serves.
export const instance = new gcp.compute.Instance(
  "substrate",
  {
    machineType,
    zone: `${location}-a`,
    tags: [substrateTag],
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
      email: substrateRunner.email,
      scopes: ["cloud-platform"],
    },
    // OS Login ties SSH access to IAM (the grants above) instead of managing keys by hand.
    // `user-data` is COS cloud-init: it boots the portal compose stack on first boot (see
    // portal-bootstrap.ts). Replacing the VM re-runs it; changing it on a running VM does not.
    metadata: { "enable-oslogin": "TRUE", "user-data": substrateUserData },
    // Allow machine-type resize (e2-medium -> e2-standard-2) without recreating the VM.
    allowStoppingForUpdate: true,
  },
  { dependsOn: [network, computeApi, osLoginApi] },
);

export const publicIp = address.address;

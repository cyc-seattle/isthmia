import * as gcp from "@pulumi/gcp";

// Private VPC for the platform. Cloud SQL (and later the VM) communicate over private IP; nothing
// here is publicly reachable. Subnets for the VM, firewall rules, and DNS are added in the
// networking slice (#77) — this provides only what Cloud SQL's private IP requires.
export const network = new gcp.compute.Network("platform", {
  autoCreateSubnetworks: false,
});

// Reserve an internal range and peer it with Google's service networking, so Cloud SQL can be
// assigned a private IP inside our VPC.
const privateRange = new gcp.compute.GlobalAddress("private-services", {
  purpose: "VPC_PEERING",
  addressType: "INTERNAL",
  prefixLength: 16,
  network: network.id,
});

export const privateServicesConnection = new gcp.servicenetworking.Connection("private-services", {
  network: network.id,
  service: "servicenetworking.googleapis.com",
  reservedPeeringRanges: [privateRange.name],
});

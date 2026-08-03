import * as gcp from "@pulumi/gcp";
import { location } from "./config";
import { enableService } from "./services";

const computeApi = enableService("compute.googleapis.com");
const servicenetworkingApi = enableService("servicenetworking.googleapis.com");

// Tag applied to the substrate VM; the firewall rules below target it.
export const substrateTag = "substrate";

// Private VPC for the substrate. Cloud SQL and the VM communicate over private IP; the VM's only
// public exposure is HTTPS via the firewall rule below.
export const network = new gcp.compute.Network(
  "substrate",
  { autoCreateSubnetworks: false },
  { dependsOn: computeApi },
);

// Regional subnet the substrate VM lives in. Private Google access lets it reach Google APIs
// without a public route.
export const subnet = new gcp.compute.Subnetwork("substrate", {
  network: network.id,
  region: location,
  ipCidrRange: "10.0.0.0/24",
  privateIpGoogleAccess: true,
});

// Caddy terminates TLS for every surface, so open 443 (and 80 for ACME/HTTP->HTTPS) to the world.
new gcp.compute.Firewall("allow-https", {
  network: network.id,
  allows: [{ protocol: "tcp", ports: ["80", "443"] }],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: [substrateTag],
});

// SSH only from Google's IAP TCP-forwarding range — no world-facing SSH port. The database is never
// exposed: it's reachable only over the private services peering, so no rule opens its port.
new gcp.compute.Firewall("allow-ssh-iap", {
  network: network.id,
  allows: [{ protocol: "tcp", ports: ["22"] }],
  sourceRanges: ["35.235.240.0/20"],
  targetTags: [substrateTag],
});

// Reserve an internal range and peer it with Google's service networking, so Cloud SQL can be
// assigned a private IP inside our VPC.
const privateRange = new gcp.compute.GlobalAddress("private-services", {
  purpose: "VPC_PEERING",
  addressType: "INTERNAL",
  prefixLength: 16,
  network: network.id,
});

export const privateServicesConnection = new gcp.servicenetworking.Connection(
  "private-services",
  {
    network: network.id,
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [privateRange.name],
  },
  { dependsOn: servicenetworkingApi },
);

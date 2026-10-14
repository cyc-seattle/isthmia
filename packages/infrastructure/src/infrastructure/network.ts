import * as gcp from "@pulumi/gcp";
import { networkId } from "./cloud";
import { enableService } from "../services";

// The cloud stack also enables it. Neither stack disables an API on destroy.
enableService("servicenetworking.googleapis.com");

// Tag applied to the substrate VM; the firewall rules below target it.
export const substrateTag = "substrate";

// Caddy terminates TLS for every surface, so open 443 (and 80 for ACME/HTTP->HTTPS) to the world.
new gcp.compute.Firewall("allow-https", {
  network: networkId,
  allows: [{ protocol: "tcp", ports: ["80", "443"] }],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: [substrateTag],
});

// SSH only from Google's IAP TCP-forwarding range — no world-facing SSH port. The database is never
// exposed: it's reachable only over the private services peering, so no rule opens its port.
new gcp.compute.Firewall("allow-ssh-iap", {
  network: networkId,
  allows: [{ protocol: "tcp", ports: ["22"] }],
  sourceRanges: ["35.235.240.0/20"],
  targetTags: [substrateTag],
});

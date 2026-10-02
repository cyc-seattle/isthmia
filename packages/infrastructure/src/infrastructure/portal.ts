import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { address } from "./compute";
import { internalDomain, internalZone } from "./dns";

// The cycsail.team link portal: a purely static site, served by the shared substrate Caddy (see
// @cyc-seattle/substrate) and gated by Authentik's forward-auth outpost (#166). This slice is just
// the portal's own DNS record — the Caddy routing, the Authentik proxy provider, and the compose
// stack are substrate's and authentik's concern. The one-time DNS-delegation step is documented in
// packages/portal/README.md.

// Point cycsail.team (the internal domain's apex) at the substrate VM's static IP. Inert until the
// registrar delegates the domain to the managed zone's name servers (a manual step); the managed
// TLS cert Caddy issues only completes once this resolves.
export const portalDnsRecord = new gcp.dns.RecordSet("portal-a", {
  name: pulumi.interpolate`${internalDomain}.`,
  type: "A",
  ttl: 300,
  managedZone: internalZone.name,
  rrdatas: [address.address],
});

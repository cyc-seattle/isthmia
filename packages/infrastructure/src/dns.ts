import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { enableService } from "./services";

const config = new pulumi.Config();

// Domains the platform serves from. Safe (example) defaults live here; the real production domains
// are set per-stack in Pulumi.prod.yaml, so a non-prod stack never touches real DNS.
//   externalDomain — public-facing website
//   internalDomain — admin / staff / volunteer portals
//   shortDomain    — link shortener
const externalDomain = config.get("externalDomain") ?? "external.example.com";
const internalDomain = config.get("internalDomain") ?? "internal.example.com";
const shortDomain = config.get("shortDomain") ?? "short.example.com";

const dnsApi = enableService("dns.googleapis.com");

/**
 * A public Cloud DNS managed zone for a domain. Creating the zone is **inert** — nothing resolves
 * through it until the domain's registrar delegates to this zone's name servers (a manual step,
 * and for the existing external domain, only after its current records are migrated in). Records
 * are added in the slices that stand up the services they point at.
 */
export class ManagedZone extends gcp.dns.ManagedZone {
  constructor(name: string, domain: pulumi.Input<string>, opts?: pulumi.CustomResourceOptions) {
    super(
      name,
      {
        // Cloud DNS requires the fully-qualified name with a trailing dot.
        dnsName: pulumi.interpolate`${domain}.`,
        description: pulumi.interpolate`DNS zone for ${domain}`,
        visibility: "public",
      },
      { dependsOn: dnsApi, ...opts },
    );
  }
}

// One managed zone per platform domain. Their name servers are exported so the registrar
// delegation (the human step) can be looked up after apply.
export const externalZone = new ManagedZone("external", externalDomain);
export const internalZone = new ManagedZone("internal", internalDomain);
export const shortZone = new ManagedZone("short", shortDomain);

export const nameServers = {
  external: externalZone.nameServers,
  internal: internalZone.nameServers,
  short: shortZone.nameServers,
};

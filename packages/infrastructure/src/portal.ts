import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { address, substrateRunner } from "./compute";
import { location } from "./config";
import { internalDomain, internalZone } from "./dns";
import { Secret } from "./secret";
import { enableService } from "./services";

// The cycsail.team link portal: a purely static site served by Caddy on the substrate VM, gated by
// oauth2-proxy (Google) restricted to the all@ group. This slice stands up everything the deploy
// needs — the image, its secrets, and DNS — that Pulumi can manage. Bringing the compose stack up
// on the VM (cloud-init) plus the one-time OAuth/domain-wide-delegation/DNS-delegation steps are
// documented in packages/portal/deploy/README.md.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// oauth2-proxy's Google client credentials and cookie secret. Declared here; values are set out of
// band (never in git) and read by the compose stack at boot. The VM's service account reads them.
const secrets = {
  "portal-oauth-client-id": new Secret("portal-oauth-client-id", { dependsOn: secretmanagerApi }),
  "portal-oauth-client-secret": new Secret("portal-oauth-client-secret", { dependsOn: secretmanagerApi }),
  "portal-oauth-cookie-secret": new Secret("portal-oauth-cookie-secret", { dependsOn: secretmanagerApi }),
};

for (const secret of Object.values(secrets)) {
  secret.grant(substrateRunner.member);
}

// Build and push the Caddy image with the static site baked in (see packages/portal/Dockerfile).
// Auth mirrors run-reports-job.ts: an OAuth2 access token from the running credentials, which also
// works when building through podman.
const imageTag = pulumi.concat(artifactRepositoryUrl, "/portal:latest");
const registryToken = gcp.organizations.getClientConfig({}).then((config) => config.accessToken);

export const portalImage = new docker.Image(
  "portal-image",
  {
    tags: [imageTag],
    context: { location: "../.." },
    dockerfile: { location: "../portal/Dockerfile" },
    platforms: ["linux/amd64"],
    push: true,
    registries: [
      {
        address: `${location}-docker.pkg.dev`,
        username: "oauth2accesstoken",
        password: registryToken,
      },
    ],
  },
  { dependsOn: artifactRepositoryAccess },
);

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

export { imageTag as portalImageTag };

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { address, substrateRunner } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { randomSecret } from "./secret";
import { enableService } from "./services";

// The cycsail.team link portal: a purely static site, served by the shared substrate Caddy (see
// @cyc-seattle/substrate) and gated by oauth2-proxy (Google), restricted to the all@ group. This
// slice is just the portal's own bits — its oauth2-proxy cookie secret and its DNS record. The
// Google OAuth client is shared platform-wide (substrate.ts); the image build and compose stack
// are substrate's concern too. The one-time OAuth/domain-wide-delegation/DNS-delegation steps are
// documented in packages/portal/README.md.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// oauth2-proxy's own cookie-signing secret — not the Google client, which is shared (substrate.ts).
// No meaningful human choice in this value, so Pulumi generates it (oauth2-proxy needs URL-safe
// base64 specifically).
export const portalOauthCookieSecret = randomSecret("portal-oauth-cookie-secret", {
  dependsOn: secretmanagerApi,
  urlSafeBase64: true,
});
portalOauthCookieSecret.secret.grant(substrateRunner.member);

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

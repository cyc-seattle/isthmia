import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "./config";
import { internalDomain } from "./dns";
import { postgres } from "./database";
import { cloudConfig, type CloudConfigParams } from "./substrate-bootstrap-script";

// Cloud-init (COS `user-data`) that boots the substrate VM's whole compose stack (the cycsail.team
// portal and the people hub/Directus) on first boot only — see substrate-apply.ts for the Pulumi
// remote-exec resource that reconciles an *already-running* VM with a later compose/image change
// (#107; COS never re-runs `user-data` on a running VM, so cloud-init alone can't do that). Kept
// separate from compute.ts so the VM slice can consume it without importing the app slices (which
// import compute.ts) — that would be a cycle. The committed compose file is the single source of
// truth; it is embedded verbatim and the secrets are fetched at boot from Secret Manager using the
// VM's own service account (no key files land in the image or git). The actual string-templating
// lives in substrate-bootstrap-script.ts, kept pulumi-free so it's unit testable.

const config = new pulumi.Config();
const authGroup = config.get("portalAuthGroup") ?? "all@cyccommunitysailing.org";
// A Workspace admin the VM's service account impersonates (via domain-wide delegation) for the
// Directory API group lookup. See packages/portal/README.md.
const authAdminEmail = config.get("portalAuthAdminEmail") ?? "master@cyccommunitysailing.org";
// Directus's own subdomain (the data-layer admin screen, not customer-facing) and its first-boot
// superadmin account.
const directusDomain = `directus.${internalDomain}`;
const directusAdminEmail = config.get("directusAdminEmail") ?? "master@cyccommunitysailing.org";
const registryHost = `${location}-docker.pkg.dev`;

/** The substrate image tag — also a trigger for substrate-apply.ts's remote-exec resource, so an
 * image-only change (no compose edit) still reconciles the running VM. */
export const imageUrl = pulumi.interpolate`${artifactRepositoryUrl}/substrate:latest`;

// The compose stack lives with the substrate. Resolve it relative to this module (via __dirname;
// this package compiles to CommonJS) rather than the process cwd, so it works however Pulumi is
// invoked: <dir> -> infrastructure -> packages -> substrate.
export const composeContent = readFileSync(
  resolve(__dirname, "../../substrate/deploy/docker-compose.yml"),
  "utf8",
).trimEnd();

/** Everything `substrateFiles`/`cloudConfig`/`remoteApplyPayload` need, fully resolved — shared by
 * cloud-init (below) and substrate-apply.ts's remote-exec resource, so "what the substrate VM
 * should look like" has exactly one derivation, applied by two different mechanisms depending on
 * whether the VM already exists. */
export const substrateParams: pulumi.Output<CloudConfigParams> = pulumi
  .all([imageUrl, postgres.privateIpAddress])
  .apply(([image, directusDbHost]) => ({
    image,
    directusDbHost,
    projectId,
    siteDomain: internalDomain,
    directusDomain,
    authGroup,
    authAdminEmail,
    directusAdminEmail,
    registryHost,
    composeProjectName: "substrate",
    composeContent,
  }));

/** COS `user-data` that stands up the substrate stack on first boot (or after a VM replace). */
export const substrateUserData: pulumi.Output<string> = substrateParams.apply((params) => cloudConfig(params));

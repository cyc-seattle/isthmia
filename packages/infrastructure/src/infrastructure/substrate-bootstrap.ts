import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "../config";
import { internalDomain } from "./dns";
import { postgres } from "./database";
import { cloudConfig, type CloudConfigParams } from "./substrate-bootstrap-script";

// Cloud-init (COS `user-data`) that boots the substrate VM's whole compose stack (the cycsail.team
// portal and the CRM/Directus) on first boot - COS never re-runs `user-data` on a running
// VM, which is why substrate-apply.ts's remote-exec resource exists for later changes. Kept
// separate from compute.ts so the VM slice can consume it without importing the app slices (which
// import compute.ts) — that would be a cycle. The actual string-templating lives in
// substrate-bootstrap-script.ts, kept pulumi-free so it's unit testable.

const config = new pulumi.Config();
const authGroup = config.get("portalAuthGroup") ?? "all@cyccommunitysailing.org";
// A Workspace admin the VM's service account impersonates (via domain-wide delegation) for the
// Directory API group lookup. See packages/portal/README.md.
const authAdminEmail = config.get("portalAuthAdminEmail") ?? "master@cyccommunitysailing.org";
// Directus's own subdomain (the data-layer admin screen, not customer-facing) and its first-boot
// superadmin account.
const directusDomain = `directus.${internalDomain}`;
const directusAdminEmail = config.get("directusAdminEmail") ?? "master@cyccommunitysailing.org";
// Authentik's own subdomain. Computed here rather than imported from authentik.ts for the same
// reason directusDomain is: authentik.ts imports `address` from ./compute, and compute.ts imports
// substrateUserData from this file, so importing back from authentik.ts would be a cycle.
const loginDomain = `login.${internalDomain}`;
const registryHost = `${location}-docker.pkg.dev`;

/** Also a trigger for substrate-apply.ts, so an image-only bump reconciles the VM too. */
export const imageUrl = pulumi.interpolate`${artifactRepositoryUrl}/substrate:latest`;

// The compose stack lives with the substrate. Resolve it relative to this module (via __dirname;
// this package compiles to CommonJS) rather than the process cwd, so it works however Pulumi is
// invoked: <dir> -> infrastructure (stack) -> src -> infrastructure (package) -> packages -> substrate.
export const composeContent = readFileSync(
  resolve(__dirname, "../../../substrate/deploy/docker-compose.yml"),
  "utf8",
).trimEnd();

// Authentik's custom email templates (#166) - see docker-compose.yml's `authentik-templates` bind
// mount and substrate-bootstrap-script.ts's `substrateFiles` for where these land on the VM.
const authentikTemplatesDir = resolve(__dirname, "../../../substrate/deploy/authentik-templates/email");
export const authentikTemplates = readdirSync(authentikTemplatesDir).map((name) => ({
  name,
  content: readFileSync(resolve(authentikTemplatesDir, name), "utf8").trimEnd(),
}));

/** Resolved params, shared by cloud-init (below) and substrate-apply.ts - one derivation, applied
 * two ways. */
export const substrateParams: pulumi.Output<CloudConfigParams> = pulumi
  .all([imageUrl, postgres.privateIpAddress])
  .apply(([image, directusDbHost]) => ({
    image,
    directusDbHost,
    projectId,
    siteDomain: internalDomain,
    directusDomain,
    loginDomain,
    authGroup,
    authAdminEmail,
    directusAdminEmail,
    registryHost,
    composeProjectName: "substrate",
    composeContent,
    authentikTemplates,
  }));

/** COS `user-data` that stands up the substrate stack on first boot (or after a VM replace). */
export const substrateUserData: pulumi.Output<string> = substrateParams.apply((params) => cloudConfig(params));

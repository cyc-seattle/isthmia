import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "./config";
import { internalDomain } from "./dns";
import { postgres } from "./database";
import { cloudConfig } from "./substrate-bootstrap-script";

// Cloud-init (COS `user-data`) that boots the substrate VM's whole compose stack (the cycsail.team
// portal and the people hub/Directus) on first boot. Kept separate from compute.ts so the VM slice
// can consume it without importing the app slices (which import compute.ts) — that would be a
// cycle. The committed compose file is the single source of truth; it is embedded verbatim and the
// secrets are fetched at boot from Secret Manager using the VM's own service account (no key files
// land in the image or git). The actual string-templating lives in substrate-bootstrap-script.ts,
// kept pulumi-free so it's unit testable.

const config = new pulumi.Config();
const authGroup = config.get("portalAuthGroup") ?? "all@cyccommunitysailing.org";
// A Workspace admin the VM's service account impersonates (via domain-wide delegation) for the
// Directory API group lookup. See packages/portal/README.md.
const authAdminEmail = config.get("portalAuthAdminEmail") ?? "master@cyccommunitysailing.org";
// The people hub's subdomain and its first-boot Directus superadmin account.
const crmDomain = `crm.${internalDomain}`;
const directusAdminEmail = config.get("directusAdminEmail") ?? "master@cyccommunitysailing.org";
const registryHost = `${location}-docker.pkg.dev`;

const imageUrl = pulumi.interpolate`${artifactRepositoryUrl}/substrate:latest`;

// The compose stack lives with the substrate. Resolve it relative to this module (via __dirname;
// this package compiles to CommonJS) rather than the process cwd, so it works however Pulumi is
// invoked: <dir> -> infrastructure -> packages -> substrate.
const composeContent = readFileSync(resolve(__dirname, "../../substrate/deploy/docker-compose.yml"), "utf8").trimEnd();

/** COS `user-data` that stands up the substrate stack on first boot. */
export const substrateUserData: pulumi.Output<string> = pulumi
  .all([imageUrl, postgres.privateIpAddress])
  .apply(([image, directusDbHost]) =>
    cloudConfig({
      image,
      directusDbHost,
      projectId,
      siteDomain: internalDomain,
      crmDomain,
      authGroup,
      authAdminEmail,
      directusAdminEmail,
      registryHost,
      composeProjectName: "substrate",
      composeContent,
    }),
  );

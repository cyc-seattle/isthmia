import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepository, artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { location } from "../config";
import { substrateRunner } from "./identities";
import { Secret } from "./secret";
import { enableService } from "../services";

// The substrate VM's shared front door: one Caddy image fronting every app that runs on it,
// routed by hostname (see packages/substrate/README.md). Not app-specific — app files (portal.ts,
// directus.ts, …) declare their own secrets/DNS/database and plug into this shared stack.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// One Google OAuth client, read directly by Authentik's Google source (../authentik/index.ts) via
// the deployer's own Pulumi credentials - not fetched by the VM, so no grant to substrateRunner.
// Values set out of band; the source's redirect URI is registered on this one client (see
// docs/manual-setup.md).
export const googleOAuthSecrets = {
  "google-oauth-client-id": new Secret("google-oauth-client-id", { dependsOn: secretmanagerApi }),
  "google-oauth-client-secret": new Secret("google-oauth-client-secret", { dependsOn: secretmanagerApi }),
};

// The VM pulls this image at boot, so its service account needs read on the repository
// (artifactRepositoryAccess only covers deployers, and only for pushing).
export const substrateImagePull = new gcp.artifactregistry.RepositoryIamMember("substrate-image-pull", {
  project: artifactRepository.project,
  location: artifactRepository.location,
  repository: artifactRepository.name,
  role: "roles/artifactregistry.reader",
  member: substrateRunner.member,
});

// Build and push the shared Caddy image (see packages/substrate/Dockerfile — bakes in the
// portal's static site, since Caddy needs it on disk). Auth mirrors run-reports-job.ts: an OAuth2
// access token from the running credentials, which also works when building through podman.
const imageTag = pulumi.concat(artifactRepositoryUrl, "/substrate:latest");

export const substrateImage = new docker.Image(
  "substrate-image",
  {
    tags: [imageTag],
    context: { location: "../../../.." },
    dockerfile: { location: "../../../substrate/Dockerfile" },
    platforms: ["linux/amd64"],
    push: true,
    registries: [
      {
        address: `${location}-docker.pkg.dev`,
        username: "oauth2accesstoken",
        password: gcp.organizations.getClientConfigOutput({}).accessToken,
      },
    ],
  },
  { dependsOn: artifactRepositoryAccess },
);

export { imageTag as substrateImageTag };

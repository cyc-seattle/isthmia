import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRegistryApi } from "./artifact-repository";
import { artifactRepository, artifactRepositoryUrl } from "./cloud";
import { location } from "../config";
import { substrateRunner } from "./identities";

// The substrate VM's shared front door: one Caddy image fronting every app that runs on it,
// routed by hostname (see packages/substrate/README.md). Not app-specific — app files (portal.ts,
// directus.ts, …) declare their own secrets/DNS/database and plug into this shared stack.

// The VM pulls this image at boot, so its service account needs read on the repository
// (the cloud stack grants only deploy-runner, and only for pushing).
export const substrateImagePull = new gcp.artifactregistry.RepositoryIamMember("substrate-image-pull", {
  project: artifactRepository.project,
  location: artifactRepository.location,
  repository: artifactRepository.name,
  role: "roles/artifactregistry.reader",
  member: substrateRunner.member,
});

// Build and push the shared Caddy image (see packages/substrate/Dockerfile — bakes in the
// portal's static site, since Caddy needs it on disk). Auth mirrors clubspot-sync-job.ts: an OAuth2
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
  { dependsOn: artifactRegistryApi },
);

export { imageTag as substrateImageTag };

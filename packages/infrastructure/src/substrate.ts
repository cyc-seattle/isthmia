import * as docker from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { artifactRepository, artifactRepositoryAccess, artifactRepositoryUrl } from "./artifact-repository";
import { substrateRunner } from "./compute";
import { location } from "./config";
import { Secret } from "./secret";
import { enableService } from "./services";

// The substrate VM's shared front door: one Caddy image fronting every app that runs on it,
// routed by hostname (see packages/substrate/README.md). Not app-specific — app files (portal.ts,
// directus.ts, …) declare their own secrets/DNS/database and plug into this shared stack.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// One Google OAuth client, shared across every surface that authenticates via Google on the
// substrate (oauth2-proxy for the portal, Directus's native OIDC for the people hub, …), so
// signing into one signs into all of them. Values set out of band; every surface's redirect URI is
// registered on this one client (see docs/manual-setup.md).
export const googleOAuthSecrets = {
  "google-oauth-client-id": new Secret("google-oauth-client-id", { dependsOn: secretmanagerApi }),
  "google-oauth-client-secret": new Secret("google-oauth-client-secret", { dependsOn: secretmanagerApi }),
};

for (const secret of Object.values(googleOAuthSecrets)) {
  secret.grant(substrateRunner.member);
}

// oauth2-proxy's ADC-based domain-wide delegation (--google-use-application-default-credentials)
// builds its Directory API assertion by calling the IAM Credentials signJwt API as the VM's own
// service account — which requires the SA to hold token creator on itself; no default grants this.
export const substrateSelfSign = new gcp.serviceaccount.IAMMember("substrate-runner-self-token-creator", {
  serviceAccountId: substrateRunner.name,
  role: "roles/iam.serviceAccountTokenCreator",
  member: substrateRunner.member,
});

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
const registryToken = gcp.organizations.getClientConfig({}).then((config) => config.accessToken);

export const substrateImage = new docker.Image(
  "substrate-image",
  {
    tags: [imageTag],
    context: { location: "../.." },
    dockerfile: { location: "../substrate/Dockerfile" },
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

export { imageTag as substrateImageTag };

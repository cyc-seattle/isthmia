import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { deployers } from "./config";
import { grantSecretAccess, makeSecret } from "./secrets";

// Service account that the always-on platform apps (Directus, oauth2-proxy, the coach/guardian
// portals, Listmonk, FreeScout) and the Clubspot -> people-hub sync run as. A single
// least-privilege identity for the self-hosted platform; resource-specific grants (Cloud SQL
// client, GCS, …) are attached in the slices that create those resources.
export const platformRunner = new gcp.serviceaccount.Account("platform-runner", {
  accountId: "platform-runner",
  displayName: "Service account for the self-hosted platform apps and sync.",
});

const platformRunnerMember = pulumi.interpolate`serviceAccount:${platformRunner.email}`;

// Allow deployers to run operations as / impersonate the platform service account, mirroring the
// report-runner pattern so the VM and local runs can act as this identity.
for (const deployer of deployers) {
  new gcp.serviceaccount.IAMMember(`platform-runner-user-${deployer}`, {
    serviceAccountId: platformRunner.name,
    role: "roles/iam.serviceAccountUser",
    member: deployer,
  });

  new gcp.serviceaccount.IAMMember(`platform-runner-impersonator-${deployer}`, {
    serviceAccountId: platformRunner.name,
    role: "roles/iam.serviceAccountTokenCreator",
    member: deployer,
  });
}

// Platform secrets. Pulumi declares only the containers and grants the platform SA read access;
// the values are set out of band and never committed. Per-app database passwords are declared
// alongside the Cloud SQL instance in a later slice (#76).
export const platformSecrets = {
  "directus-key": makeSecret("directus-key"),
  "directus-secret": makeSecret("directus-secret"),
  "directus-admin-password": makeSecret("directus-admin-password"),
  "oidc-client-secret": makeSecret("oidc-client-secret"),
};

grantSecretAccess(platformRunnerMember, platformSecrets);

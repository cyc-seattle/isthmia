import * as pulumi from "@pulumi/pulumi";
import { projectId } from "../config";
import { internalDomain } from "./dns";
import { substrateRunner } from "./identities";
import { secretAccessor } from "../secret";

// Directus on the substrate VM. Its secrets, database, roles, users, and DNS record are `crm`'s
// (#231); the VM reads the secrets from Secret Manager at boot.

for (const secretId of [
  "directus-key",
  "directus-secret",
  "directus-db-password",
  "directus-admin-bootstrap-password",
  "directus-license-key",
  "directus-community-role-id",
]) {
  secretAccessor(secretId, substrateRunner.member, "substrate-runner", projectId);
}

export const directusBaseUrl = pulumi.interpolate`https://directus.${internalDomain}`;

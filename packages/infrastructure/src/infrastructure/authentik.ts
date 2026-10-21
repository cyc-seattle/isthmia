import { projectId } from "../config";
import { substrateRunner } from "./identities";
import { secretAccessor } from "../secret";

// Authentik on the substrate VM. Its secrets, database, and DNS record are `authentik`'s (#231);
// the VM reads the secrets from Secret Manager at boot.

for (const secretId of [
  "authentik-secret-key",
  "authentik-db-password",
  "authentik-bootstrap-token",
  "authentik-bootstrap-password",
  "directus-oidc-client-secret",
]) {
  secretAccessor(secretId, substrateRunner.member, "substrate-runner", projectId);
}

import { postgres } from "./database";
import { substrateRunner } from "./compute";
import { Secret } from "./secret";
import { enableService } from "./services";

// The people hub: Directus, running on the substrate VM against its own database on the shared
// Cloud SQL instance. See docs/people-hub-schema.md for the data model this backs. One database
// for the whole Directus instance, not one per use case (e.g. "people_hub") — Directus's own
// collections are how data is organized within it; a second use case is a new collection here, not
// a new database.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

export const directusDatabase = postgres.database("directus");

// Directus's own secrets, plus its native Google OIDC client. Declared here; values are set out of
// band (never in git) and read by the compose stack at boot, same pattern as portal.ts.
const secrets = {
  // Directus's own encryption/signing secrets (its `KEY`/`SECRET` env vars).
  "directus-key": new Secret("directus-key", { dependsOn: secretmanagerApi }),
  "directus-secret": new Secret("directus-secret", { dependsOn: secretmanagerApi }),
  "directus-db-password": new Secret("directus-db-password", { dependsOn: secretmanagerApi }),
  // First-boot admin account password; rotate and stop using once real staff users exist.
  "directus-admin-bootstrap-password": new Secret("directus-admin-bootstrap-password", {
    dependsOn: secretmanagerApi,
  }),
  // A separate OAuth client from the portal's (own redirect URI: crm.<internalDomain>).
  "directus-oauth-client-id": new Secret("directus-oauth-client-id", { dependsOn: secretmanagerApi }),
  "directus-oauth-client-secret": new Secret("directus-oauth-client-secret", { dependsOn: secretmanagerApi }),
};

for (const secret of Object.values(secrets)) {
  secret.grant(substrateRunner.member);
}

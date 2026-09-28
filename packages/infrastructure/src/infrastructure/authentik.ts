import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as postgresql from "@pulumi/postgresql";
import { postgres } from "./database";
import { address } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { substrateRunner } from "./identities";
import { Secret, randomSecret } from "./secret";
import { enableService } from "../services";

// Authentik: the platform's identity provider, replacing oauth2-proxy as the sign-in gate for
// every surface on the substrate VM (#166). Runs against its own database on the shared Cloud SQL
// instance, same pattern as directus.ts. This file stands up the container's data and secrets
// only — no flows, sources, applications, or groups, which are a separate Pulumi project applied
// after this one.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// Internal secrets with no meaningful human choice - Pulumi generates and manages them directly,
// same reasoning as directus.ts's own secrets.
export const authentikSecretKey = randomSecret("authentik-secret-key", { dependsOn: secretmanagerApi });
export const authentikDbPassword = randomSecret("authentik-db-password", { dependsOn: secretmanagerApi });
// akadmin's API token, read only on first boot (AUTHENTIK_BOOTSTRAP_TOKEN).
export const authentikBootstrapToken = randomSecret("authentik-bootstrap-token", { dependsOn: secretmanagerApi });
// akadmin's first-boot password - the break-glass login, same role as
// directus-admin-bootstrap-password.
export const authentikBootstrapPassword = randomSecret("authentik-bootstrap-password", {
  dependsOn: secretmanagerApi,
});
// The Directus OIDC application's client secret (#166). Generated here so Authentik's own config
// (a later project) and Directus's `authentik` auth provider (a later change to directus.ts) read
// the same value by name; neither exists yet, so nothing consumes this secret until then.
export const directusOidcClientSecret = randomSecret("directus-oidc-client-secret", {
  dependsOn: secretmanagerApi,
});

// The Google source's OAuth client (../authentik's SourceOauth) - an external credential, so it
// stays a plain Secret (container only, value set out of band) same as directus-license-key.
// See docs/manual-setup.md for creating the client and storing its id/secret here. Read only by
// ../authentik at plan time (as the deployer, not substrate-runner) - the running container never
// needs it, unlike directus-license-key.
export const authentikGoogleClientId = new Secret("authentik-google-client-id", { dependsOn: secretmanagerApi });
export const authentikGoogleClientSecret = new Secret("authentik-google-client-secret", {
  dependsOn: secretmanagerApi,
});

for (const secret of [
  authentikSecretKey.secret,
  authentikDbPassword.secret,
  authentikBootstrapToken.secret,
  authentikBootstrapPassword.secret,
  directusOidcClientSecret.secret,
]) {
  secret.grant(substrateRunner.member, "substrate-runner");
}

// The Postgres role Authentik connects as - created via the Cloud SQL Admin API, same as
// directus.ts's own user.
export const authentikDbUser = postgres.user("authentik", authentikDbPassword.value);

// Reaches Cloud SQL's private IP through the IAP tunnel `just deploy` raises, same as
// directus.ts's own provider.
const authentikDbProvider = new postgresql.Provider("authentik-db", {
  host: "localhost",
  port: new pulumi.Config().getNumber("dbTunnelPort") ?? 5432,
  database: "postgres",
  username: authentikDbUser.name,
  password: authentikDbPassword.value,
  superuser: false,
  sslMode: "disable",
});

// Owned by authentik, not merely granted to it - see directus.ts's own `directusDatabase` for why
// (Postgres 15+ grants CREATE on the public schema only to the database owner; the Admin API can't
// set one).
export const authentikDatabase = new postgresql.Database(
  "authentik",
  { name: "authentik", owner: authentikDbUser.name },
  { provider: authentikDbProvider, dependsOn: authentikDbUser },
);

// Point login.<internalDomain> at the substrate VM, same pattern as directus.ts's own record.
export const authentikDnsRecord = new gcp.dns.RecordSet("authentik-a", {
  name: pulumi.interpolate`login.${internalDomain}.`,
  type: "A",
  ttl: 300,
  managedZone: internalZone.name,
  rrdatas: [address.address],
});

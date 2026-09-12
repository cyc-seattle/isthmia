import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as postgresql from "@pulumi/postgresql";
import { postgres } from "./database";
import { address } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { substrateRunner } from "./identities";
import { Secret, randomSecret } from "./secret";
import { enableService } from "../services";

// Directus itself: the substrate for the people hub (and any future app that wants a
// relationship-based permission engine — see docs/architecture.md). Runs on the substrate VM
// against its own database on the shared Cloud SQL instance. One database for the whole instance,
// not one per app — Directus's own collections are how data is organized within it.
//
// App-specific schema/roles/users (e.g. the people hub's) live in that app's own file — see
// people-hub.ts — built on the DirectusRole/DirectusUser/DirectusSchema resources in
// ../directus/resources.ts.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

// Directus's own secrets. The Google OAuth client is shared platform-wide (substrate.ts), not
// declared here — signing in once should sign into every surface on the substrate, not just this
// one.
//
// The internal ones (key/secret/db password/bootstrap password) have no meaningful human choice,
// so Pulumi generates and manages their values directly (randomSecret) — nothing to set out of
// band. `directus-license-key` stays a plain Secret: it's an external credential (the Open
// Innovation Grant / a paid license), same "container only, value out of band" pattern as
// `google-oauth-client-id`/`-secret` in substrate.ts.
const directusKey = randomSecret("directus-key", { dependsOn: secretmanagerApi });
const directusSecret = randomSecret("directus-secret", { dependsOn: secretmanagerApi });
const directusDbPassword = randomSecret("directus-db-password", { dependsOn: secretmanagerApi });
// First-boot admin account password; rotate and stop using once real staff users exist (see
// people-hub.ts's DirectusUser for ungood's own account, which doesn't need this at all). Also
// what the DirectusRole/DirectusUser/DirectusSchema dynamic resources authenticate with.
const directusAdminBootstrapPassword = randomSecret("directus-admin-bootstrap-password", {
  dependsOn: secretmanagerApi,
});
// Directus 12+ (MSCL-licensed) gates custom/relational permission rules — exactly what the
// Guardian role below needs — behind a license. CYC has one via Directus's Open Innovation Grant;
// see docs/manual-setup.md §6.
const directusLicenseKey = new Secret("directus-license-key", { dependsOn: secretmanagerApi });

for (const secret of [
  directusKey.secret,
  directusSecret.secret,
  directusDbPassword.secret,
  directusAdminBootstrapPassword.secret,
  directusLicenseKey,
]) {
  secret.grant(substrateRunner.member);
}

export { directusKey, directusSecret, directusDbPassword, directusAdminBootstrapPassword };

// The Postgres role Directus connects as — created via the Cloud SQL Admin API, which needs no
// network path to the instance.
export const directusDbUser = postgres.user("directus", directusDbPassword.value);

// Reaches Cloud SQL's private IP through the IAP tunnel `just deploy` raises; the Cloud SQL
// connectors authorize connections but can't route into the VPC from outside it. `superuser: false`
// because Cloud SQL roles hold cloudsqlsuperuser, not real SUPERUSER.
const directusDbProvider = new postgresql.Provider("directus-db", {
  host: "localhost",
  port: new pulumi.Config().getNumber("dbTunnelPort") ?? 5432,
  database: "postgres",
  username: directusDbUser.name,
  password: directusDbPassword.value,
  superuser: false,
  sslMode: "disable",
});

// Owned by directus, not merely granted to it: since Postgres 15 the public schema grants CREATE
// only to the database owner, and the Admin API can't set an owner (#112).
export const directusDatabase = new postgresql.Database(
  "directus",
  { name: "directus", owner: directusDbUser.name },
  { provider: directusDbProvider, dependsOn: directusDbUser },
);

// Point directus.<internalDomain> at the substrate VM, same pattern as portal.ts's own record.
export const directusDnsRecord = new gcp.dns.RecordSet("directus-a", {
  name: pulumi.interpolate`directus.${internalDomain}.`,
  type: "A",
  ttl: 300,
  managedZone: internalZone.name,
  rrdatas: [address.address],
});

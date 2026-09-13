import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as postgresql from "@pulumi/postgresql";
import { postgres } from "./database";
import { address } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { substrateRunner } from "./identities";
import { Secret, randomSecret } from "./secret";
import { enableService } from "../services";

// Directus itself: the substrate for the CRM (and any future app that wants a
// relationship-based permission engine — see docs/architecture.md). Runs on the substrate VM
// against its own database on the shared Cloud SQL instance. One database for the whole instance,
// not one per app — Directus's own collections are how data is organized within it.
//
// Roles/users are identity, not app data, and live in directus-roles.ts; an app's own schema and
// permission rules (e.g. the CRM's) live in that app's own project — see ../crm/.
// Both build on the DirectusRole/DirectusUser/DirectusSchema/DirectusPermissionRule resources in
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
// directus-roles.ts's DirectusUser for ungood's own account, which doesn't need this at all). Also
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
  secret.grant(substrateRunner.member, "substrate-runner");
}

export { directusKey, directusSecret, directusDbPassword, directusAdminBootstrapPassword };

// The clubspot-sync job's Directus static token. Pulumi generates and owns the value, same as the
// internal secrets above, and passes it straight into the machine user's DirectusUser
// (directus-roles.ts) - no round trip through Secret Manager. Granted to the clubspot-sync service
// account, not substrateRunner: the VM never needs it.
export const clubspotSyncDirectusToken = randomSecret("clubspot-sync-directus-token", { dependsOn: secretmanagerApi });

// Same default as substrate-bootstrap.ts's DIRECTUS_ADMIN_EMAIL — kept as a separate read (not a
// shared import) to avoid a cycle: compute.ts -> substrate-bootstrap.ts, and this file must not be
// part of that chain.
export const directusAdminEmail = new pulumi.Config().get("directusAdminEmail") ?? "master@cyccommunitysailing.org";

export const directusBaseUrl = pulumi.interpolate`https://directus.${internalDomain}`;

// The bootstrap admin's actual password — not just a reference to the secret container, the value
// itself — because these resources authenticate to the Directus API as that admin to create
// schema/roles/users. This is the one place in the program that reads a Secret Manager value
// rather than just declaring/granting the container; it never leaves the deployer's own
// `pulumi up` process, which already has legitimate access to it (they're the one who set it, or
// in this case, the one Pulumi generated it for above).
//
// `dependsOn: directusAdminBootstrapPassword.version` matters: `getSecretVersionOutput` takes a
// plain secret ID string, which carries no implicit dependency, so without this Pulumi has no way
// to know this read must happen after that secret's value is actually written — it would otherwise
// run immediately, failing on a fresh deploy where the secret doesn't exist yet even though this
// same `pulumi up` is about to create it.
export const adminPassword = gcp.secretmanager
  .getSecretVersionOutput(
    { secret: "directus-admin-bootstrap-password" },
    { dependsOn: directusAdminBootstrapPassword.version },
  )
  .apply((version) => version.secretData);

// The bundle every Directus* dynamic resource (schema/role/permission-rule/user, wherever they're
// declared) needs to authenticate to this instance's API.
export const auth = { baseUrl: directusBaseUrl, adminEmail: directusAdminEmail, adminPassword };

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

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { crmIdentities } from "../directus/roles";
import { Secret, randomSecret } from "../secret";
import { infrastructureOutput, vmDatabase, vmDnsRecord } from "../vm";

// Directus's generated secrets, database, record, roles, and users while it runs on the VM (#231).
// The VM reads the secrets from Secret Manager by name.

export function directusOnVm(adminEmail: string, admins: string[], externalDomain: string) {
  randomSecret("directus-key");
  randomSecret("directus-secret");
  const dbPassword = randomSecret("directus-db-password");
  // The built-in admin's password. The resources here and in ./index.ts sign in with it.
  const adminPassword = randomSecret("directus-admin-bootstrap-password");
  // Set by hand: the Open Innovation Grant's key (docs/manual-setup.md §6).
  new Secret("directus-license-key");
  const clubspotSyncToken = randomSecret("clubspot-sync-directus-token");
  const gsuiteSyncToken = randomSecret("gsuite-sync-directus-token");
  vmDatabase("directus", dbPassword.value);
  vmDnsRecord("directus-a", "directus");

  const auth = {
    baseUrl: infrastructureOutput("directusBaseUrl"),
    adminEmail,
    adminPassword: pulumi.secret(adminPassword.value),
  };
  const roles = crmIdentities({
    auth,
    readyForApiCalls: [],
    admins,
    externalDomain,
    clubspotSyncToken: clubspotSyncToken.value,
    gsuiteSyncToken: gsuiteSyncToken.value,
  });

  // The VM's Directus names the Community role as its default role, by this secret. The role's ID
  // exists only once the role does, so the VM can't take it as a plain value.
  const communityRoleIdSecret = new Secret("directus-community-role-id");
  new gcp.secretmanager.SecretVersion("directus-community-role-id-version", {
    secret: communityRoleIdSecret.id,
    secretData: roles.communityRole.roleId,
  });

  return { auth, roles };
}

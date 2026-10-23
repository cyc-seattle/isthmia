import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { crmIdentities } from "../directus/roles";
import { Secret, randomSecret } from "../secret";
import { prodDatabase } from "../cloud";

// Prod Directus's generated secrets, database, record, roles, and users, which moved here from
// `infrastructure` (#231). They keep their names and values on the cluster: Directus's license
// activation is tied to its database and URL (#172).

export interface ProdDirectusArgs {
  adminEmail: string;
  admins: string[];
  externalDomain: string;
  baseUrl: pulumi.Input<string>;
}

export function prodDirectus({ adminEmail, admins, externalDomain, baseUrl }: ProdDirectusArgs) {
  const key = randomSecret("directus-key");
  const secret = randomSecret("directus-secret");
  const dbPassword = randomSecret("directus-db-password");
  // The built-in admin's password. The resources here and in ./index.ts sign in with it.
  const adminPassword = randomSecret("directus-admin-bootstrap-password");
  // Set by hand: the Open Innovation Grant's key (docs/manual-setup.md §6).
  new Secret("directus-license-key");
  const clubspotSyncToken = randomSecret("clubspot-sync-directus-token");
  const gsuiteSyncToken = randomSecret("gsuite-sync-directus-token");
  prodDatabase("directus", dbPassword.value);

  const auth = {
    baseUrl,
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

  // The VM's Directus read the Community role's ID from this secret. Nothing reads it now.
  const communityRoleIdSecret = new Secret("directus-community-role-id");
  new gcp.secretmanager.SecretVersion("directus-community-role-id-version", {
    secret: communityRoleIdSecret.id,
    secretData: roles.communityRole.roleId,
  });

  return {
    auth,
    roles,
    clubspotSyncToken: pulumi.secret(clubspotSyncToken.value),
    gsuiteSyncToken: pulumi.secret(gsuiteSyncToken.value),
    values: {
      key: key.value,
      secret: secret.value,
      dbPassword: dbPassword.value,
      adminPassword: adminPassword.value,
      communityRoleId: roles.communityRole.roleId,
    },
  };
}

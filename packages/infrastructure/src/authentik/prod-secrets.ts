import type * as pulumi from "@pulumi/pulumi";
import { randomSecret } from "../secret";
import { prodDatabase } from "../cloud";

// Prod's generated secrets and database, from its time on the VM (#231). The cluster takes the same
// values, so nothing rotates.

export interface AuthentikSecrets {
  secretKey: pulumi.Output<string>;
  /** akadmin's API token, which this project's provider signs in with. */
  bootstrapToken: pulumi.Output<string>;
  /** akadmin's first-boot password, the break-glass login. */
  bootstrapPassword: pulumi.Output<string>;
}

export interface ProdSecrets extends AuthentikSecrets {
  dbPassword: pulumi.Output<string>;
  /** Directus's `authentik` auth provider reads it too, until prod moves to platform's `backend`. */
  directusOidcClientSecret: pulumi.Output<string>;
}

export function prodSecrets(): ProdSecrets {
  const secretKey = randomSecret("authentik-secret-key");
  const dbPassword = randomSecret("authentik-db-password");
  const bootstrapToken = randomSecret("authentik-bootstrap-token");
  const bootstrapPassword = randomSecret("authentik-bootstrap-password");
  const directusOidcClientSecret = randomSecret("directus-oidc-client-secret");
  prodDatabase("authentik", dbPassword.value);
  return {
    secretKey: secretKey.value,
    dbPassword: dbPassword.value,
    bootstrapToken: bootstrapToken.value,
    bootstrapPassword: bootstrapPassword.value,
    directusOidcClientSecret: directusOidcClientSecret.value,
  };
}

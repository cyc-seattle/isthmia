import { randomSecret } from "../secret";
import { vmDatabase, vmDnsRecord } from "../vm";

// Authentik's generated secrets, database, and record while it runs on the VM (#231). The VM reads
// the secrets from Secret Manager by name.

export function authentikOnVm() {
  randomSecret("authentik-secret-key");
  const dbPassword = randomSecret("authentik-db-password");
  // akadmin's API token, read only on first boot.
  const bootstrapToken = randomSecret("authentik-bootstrap-token");
  // akadmin's first-boot password, the break-glass login.
  randomSecret("authentik-bootstrap-password");
  // Directus's `authentik` auth provider reads it on the VM too.
  const directusOidcClientSecret = randomSecret("directus-oidc-client-secret");
  vmDatabase("authentik", dbPassword.value);
  vmDnsRecord("authentik-a", "login");
  return { bootstrapToken: bootstrapToken.value, directusOidcClientSecret: directusOidcClientSecret.value };
}

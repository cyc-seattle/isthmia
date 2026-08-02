import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * Declares a Secret Manager secret with automatic replication. This creates only the container;
 * the secret *value* is set out of band (Secret Manager UI / `gcloud secrets versions add`) and
 * never lives in git.
 */
export function makeSecret(secretName: string): gcp.secretmanager.Secret {
  return new gcp.secretmanager.Secret(secretName, {
    secretId: secretName,
    replication: {
      auto: {},
    },
  });
}

/**
 * Grants a member (e.g. `serviceAccount:foo@…`) permission to read the values of the given secrets.
 */
export function grantSecretAccess(
  member: pulumi.Input<string>,
  secrets: Record<string, gcp.secretmanager.Secret>,
): void {
  for (const [name, secret] of Object.entries(secrets)) {
    new gcp.secretmanager.SecretIamMember(`secret-accessor-${name}`, {
      secretId: secret.secretId,
      project: secret.project,
      role: "roles/secretmanager.secretAccessor",
      member,
    });
  }
}

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";

/**
 * A Secret Manager secret with secure defaults (automatic replication). This declares only the
 * container; the value is set out of band (Secret Manager UI / `gcloud secrets versions add`) and
 * never lives in git. Use {@link Secret.grant} to let a member read the value.
 *
 * For a secret whose value has no meaningful human choice — an internal key or password, not an
 * external credential like an OAuth client secret — use {@link randomSecret} instead, which also
 * generates and sets the value.
 */
export class Secret extends gcp.secretmanager.Secret {
  constructor(
    protected readonly plainId: string,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(plainId, { secretId: plainId, replication: { auto: {} } }, opts);
  }

  /** Grants a member (e.g. `serviceAccount:foo@…`) permission to read this secret's value. */
  grant(member: pulumi.Input<string>): gcp.secretmanager.SecretIamMember {
    return new gcp.secretmanager.SecretIamMember(`secret-accessor-${this.plainId}`, {
      secretId: this.secretId,
      project: this.project,
      role: "roles/secretmanager.secretAccessor",
      member,
    });
  }
}

export interface GeneratedSecret {
  /** The secret container — use `.grant()` on this to let something read it. */
  secret: Secret;
  /** The generated value itself, for feeding directly into another resource (e.g. a `gcp.sql.User`
   * password) without a round trip through Secret Manager. */
  value: pulumi.Output<string>;
}

/**
 * A Secret Manager secret whose value Pulumi generates and manages directly, for secrets with no
 * meaningful human choice — internal encryption keys, generated passwords — as opposed to external
 * credentials (an OAuth client secret, a third-party login) that stay declared-only with values
 * set out of band. Regenerating on every `pulumi up` would break whatever's using the old value, so
 * the random value is a resource in its own right (stable across previews/updates that don't touch
 * it), not recomputed inline.
 */
export function randomSecret(
  plainId: string,
  opts?: pulumi.CustomResourceOptions & { urlSafeBase64?: boolean },
): GeneratedSecret {
  const secret = new Secret(plainId, opts);
  const bytes = new random.RandomBytes(`${plainId}-value`, { length: 32 }, { parent: secret });
  const value = opts?.urlSafeBase64
    ? bytes.base64.apply((encoded) => encoded.replace(/\+/g, "-").replace(/\//g, "_"))
    : bytes.hex;
  new gcp.secretmanager.SecretVersion(
    `${plainId}-version`,
    { secret: secret.id, secretData: value },
    { parent: secret },
  );
  return { secret, value };
}

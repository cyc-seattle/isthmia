import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * A Secret Manager secret with secure defaults (automatic replication). This declares only the
 * container; the value is set out of band (Secret Manager UI / `gcloud secrets versions add`) and
 * never lives in git. Use {@link Secret.grant} to let a member read the value.
 */
export class Secret extends gcp.secretmanager.Secret {
  constructor(
    private readonly plainId: string,
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

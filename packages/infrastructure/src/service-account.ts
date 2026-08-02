import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/** A GCP service account with a convenient IAM `member` string and impersonation helpers. */
export class ServiceAccount extends gcp.serviceaccount.Account {
  constructor(accountId: string, displayName: string, opts?: pulumi.CustomResourceOptions) {
    super(accountId, { accountId, displayName }, opts);
  }

  // The IAM member string (`serviceAccount:{email}`) is provided by the base class as `.member`.

  /**
   * Lets the given members run operations as, and mint tokens for (impersonate), this service
   * account.
   */
  allowImpersonation(members: string[]): void {
    for (const member of members) {
      new gcp.serviceaccount.IAMMember(`${member}-user`, {
        serviceAccountId: this.name,
        role: "roles/iam.serviceAccountUser",
        member,
      });

      new gcp.serviceaccount.IAMMember(`${member}-impersonator`, {
        serviceAccountId: this.name,
        role: "roles/iam.serviceAccountTokenCreator",
        member,
      });
    }
  }
}

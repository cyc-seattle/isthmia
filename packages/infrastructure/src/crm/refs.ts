import * as pulumi from "@pulumi/pulumi";

// The Directus instance, and the roles this app attaches rules to, live in ../infrastructure, a
// separate Pulumi stack. This is the one place `crm` reads across that boundary — add new outputs
// to stringOutput below rather than a second StackReference elsewhere, so every cross-stack read
// goes through the same requireOutput guard (see identities.ts for the same pattern one stack
// over).

/** The Directus instance and roles in ../infrastructure. Only an off-cluster stack reads them. */
export function infrastructureRefs() {
  const infrastructure = new pulumi.StackReference(new pulumi.Config().require("infrastructureStack"));

  function stringOutput(outputName: string): pulumi.Output<string> {
    // requireOutput (not getOutput) so a missing or misnamed output fails with the output's own
    // name, rather than resolving to `undefined` and reaching Directus as `...[_eq]=undefined`.
    return infrastructure.requireOutput(outputName).apply((value: string) => value);
  }

  return {
    directusBaseUrl: stringOutput("directusBaseUrl"),
    staffPolicyId: stringOutput("staffPolicyId"),
    coachPolicyId: stringOutput("coachPolicyId"),
    guardianPolicyId: stringOutput("guardianPolicyId"),
    clubspotSyncPolicyId: stringOutput("clubspotSyncPolicyId"),
    gsuiteSyncPolicyId: stringOutput("gsuiteSyncPolicyId"),
    communityRoleId: stringOutput("communityRoleId"),
  };
}

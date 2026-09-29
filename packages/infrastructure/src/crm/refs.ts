import * as pulumi from "@pulumi/pulumi";

// The Directus instance, and the roles this app attaches rules to, live in ../infrastructure, a
// separate Pulumi stack. This is the one place `crm` reads across that boundary — add new outputs
// to stringOutput below rather than a second StackReference elsewhere, so every cross-stack read
// goes through the same requireOutput guard (see identities.ts for the same pattern one stack
// over).

const infrastructureStack =
  new pulumi.Config().get("infrastructureStack") ?? `ungood/infrastructure/${pulumi.getStack()}`;

const infrastructure = new pulumi.StackReference(infrastructureStack);

function stringOutput(outputName: string): pulumi.Output<string> {
  // requireOutput (not getOutput) so a missing or misnamed output fails with the output's own
  // name, rather than resolving to `undefined` and reaching Directus as `...[_eq]=undefined`.
  return infrastructure.requireOutput(outputName).apply((value: string) => value);
}

export const directusBaseUrl = stringOutput("directusBaseUrl");
export const staffPolicyId = stringOutput("staffPolicyId");
export const coachPolicyId = stringOutput("coachPolicyId");
export const guardianPolicyId = stringOutput("guardianPolicyId");
export const clubspotSyncPolicyId = stringOutput("clubspotSyncPolicyId");
export const gsuiteSyncPolicyId = stringOutput("gsuiteSyncPolicyId");

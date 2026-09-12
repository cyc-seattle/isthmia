import * as pulumi from "@pulumi/pulumi";

// The Directus instance, and the roles this app attaches rules to, live in ../infrastructure, a
// separate Pulumi stack (see .claude/plans/people-hub-project-split.md). This is the one place
// people-hub reads across that boundary — see identities.ts for the same pattern one stack over.

const infrastructureStack =
  new pulumi.Config().get("infrastructureStack") ?? `ungood/infrastructure/${pulumi.getStack()}`;

const infrastructure = new pulumi.StackReference(infrastructureStack);

function stringOutput(outputName: string): pulumi.Output<string> {
  return infrastructure.getOutput(outputName).apply((value: string) => value);
}

export const directusBaseUrl = stringOutput("directusBaseUrl");
export const staffPolicyId = stringOutput("staffPolicyId");
export const coachPolicyId = stringOutput("coachPolicyId");
export const guardianPolicyId = stringOutput("guardianPolicyId");

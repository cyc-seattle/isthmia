import * as pulumi from "@pulumi/pulumi";

// Identities and their project-level IAM live in ../bootstrap, a separate Pulumi stack (see
// .claude/plans/deployer-access.md). This is the one place `infrastructure` reads across that boundary.

const bootstrapStack = new pulumi.Config().get("bootstrapStack") ?? `ungood/bootstrap/${pulumi.getStack()}`;

const bootstrap = new pulumi.StackReference(bootstrapStack);

/** An identity exported by `../bootstrap` — a subset of `gcp.serviceaccount.Account`'s
 * output properties, enough for the consumers here (attaching the account to a resource, or
 * granting it access to something). */
export interface Identity {
  email: pulumi.Output<string>;
  member: pulumi.Output<string>;
  name: pulumi.Output<string>;
}

function identity(outputName: string): Identity {
  const output = bootstrap.getOutput(outputName);
  return {
    email: output.apply((value: { email: string }) => value.email),
    member: output.apply((value: { member: string }) => value.member),
    name: output.apply((value: { name: string }) => value.name),
  };
}

export const substrateRunner = identity("substrateRunner");
export const reportRunner = identity("reportRunner");
export const clubspotSyncRunner = identity("clubspotSyncRunner");

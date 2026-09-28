import * as pulumi from "@pulumi/pulumi";

// The one value this project needs from ../infrastructure's stack: the domain every hostname here
// (login., preview., directus.) is built from. Same StackReference pattern as ../crm/refs.ts -
// add further cross-stack reads to stringOutput below, rather than a second StackReference
// elsewhere.

const infrastructureStack =
  new pulumi.Config().get("infrastructureStack") ?? `ungood/infrastructure/${pulumi.getStack()}`;

const infrastructure = new pulumi.StackReference(infrastructureStack);

function stringOutput(outputName: string): pulumi.Output<string> {
  // requireOutput (not getOutput) so a missing or misnamed output fails with the output's own
  // name, rather than resolving to `undefined` and building a hostname like "login.undefined".
  return infrastructure.requireOutput(outputName).apply((value: string) => value);
}

export const internalDomain = stringOutput("internalDomain");

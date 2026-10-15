import * as pulumi from "@pulumi/pulumi";

// The one value this project needs from ../infrastructure's stack: the domain every hostname here
// (login., directus.) is built from. Same StackReference pattern as ../crm/refs.ts -
// add further cross-stack reads to stringOutput below, rather than a second StackReference
// elsewhere.

function stringOutput(outputName: string): pulumi.Output<string> {
  const infrastructure = new pulumi.StackReference(new pulumi.Config().require("infrastructureStack"));
  // requireOutput (not getOutput) so a missing or misnamed output fails with the output's own
  // name, rather than resolving to `undefined` and building a hostname like "login.undefined".
  return infrastructure.requireOutput(outputName).apply((value: string) => value);
}

/** Only an off-cluster stack reads it. On the cluster, the domain is the platform's. */
export function infrastructureDomain(): pulumi.Output<string> {
  return stringOutput("internalDomain");
}

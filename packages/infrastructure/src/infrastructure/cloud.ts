import * as pulumi from "@pulumi/pulumi";

// The VPC, the Cloud SQL instance, the DNS zones, and Artifact Registry live in
// cyc-seattle/platform's cloud stack (#215). This is the one place `infrastructure` reads them.

const cloud = new pulumi.StackReference(new pulumi.Config().require("cloudStack"));

function stringOutput(outputName: string): pulumi.Output<string> {
  // requireOutput, so a missing output fails with its own name instead of resolving to undefined.
  return cloud.requireOutput(outputName).apply((value: string) => value);
}

export const networkId = stringOutput("networkId");
export const subnetId = stringOutput("subnetId");
export const postgresInstanceName = stringOutput("postgresInstanceName");
export const postgresPrivateIp = stringOutput("postgresPrivateIp");
export const internalZoneName = stringOutput("internalZoneName");
export const artifactRepository = {
  project: stringOutput("artifactRepositoryProject"),
  location: stringOutput("artifactRepositoryLocation"),
  name: stringOutput("artifactRepositoryName"),
};
export const artifactRepositoryUrl = stringOutput("artifactRepositoryUrl");

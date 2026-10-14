import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The Pulumi backend comes from mise.toml's env, so these read it the way a deploy does.
function miseEnv(stack?: string): Record<string, string> {
  const env = { ...process.env };
  delete env["PULUMI_STACK"];
  delete env["PULUMI_BACKEND_URL"];
  if (stack) env["PULUMI_STACK"] = stack;
  return JSON.parse(execFileSync("mise", ["env", "--json"], { env, encoding: "utf8" }));
}

describe("the Pulumi backend", () => {
  it("defaults to the prod stack and its bucket", () => {
    expect(miseEnv()).toMatchObject({
      PULUMI_STACK: "prod",
      PULUMI_BACKEND_URL: "gs://cyc-admin-scripts-pulumi-prod",
    });
  });

  it("follows PULUMI_STACK to that environment's bucket", () => {
    expect(miseEnv("dev")).toMatchObject({
      PULUMI_STACK: "dev",
      PULUMI_BACKEND_URL: "gs://cyc-admin-scripts-pulumi-dev",
    });
  });

  it("points gcloud at the project", () => {
    expect(miseEnv()).toMatchObject({ GCP_PROJECT: "cyc-admin-scripts", CLOUDSDK_CORE_PROJECT: "cyc-admin-scripts" });
  });
});

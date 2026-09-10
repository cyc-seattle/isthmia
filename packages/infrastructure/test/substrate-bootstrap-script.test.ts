import { describe, it, expect } from "vitest";
import { bootstrapScript, type BootstrapScriptParams } from "../src/substrate-bootstrap-script.js";

function makeParams(overrides: Partial<BootstrapScriptParams> = {}): BootstrapScriptParams {
  return {
    image: "us-west1-docker.pkg.dev/proj/repo/substrate:latest",
    directusDbHost: "10.0.0.5",
    projectId: "cyc-admin-scripts",
    siteDomain: "internal.example.com",
    crmDomain: "crm.internal.example.com",
    authGroup: "all@cyccommunitysailing.org",
    authAdminEmail: "master@cyccommunitysailing.org",
    directusAdminEmail: "master@cyccommunitysailing.org",
    registryHost: "us-west1-docker.pkg.dev",
    composeProjectName: "substrate",
    ...overrides,
  };
}

describe("bootstrapScript", () => {
  it("removes containers from any other compose project before pulling/starting this one", () => {
    const script = bootstrapScript(makeParams());

    const cleanupIndex = script.indexOf('project" != "substrate"');
    const pullIndex = script.indexOf("docker-compose.yml pull");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(pullIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeLessThan(pullIndex);

    // The cleanup loop must not remove containers belonging to this project's own compose stack.
    expect(script).toContain(
      'if [ -n "$project" ] && [ "$project" != "substrate" ]; then docker rm -f "$cid" || true; fi',
    );
  });

  it("scopes the cleanup to whatever the project's own compose-project name is", () => {
    const script = bootstrapScript(makeParams({ composeProjectName: "some-other-project" }));

    expect(script).toContain('"$project" != "some-other-project"');
    expect(script).not.toContain('"$project" != "substrate"');
  });
});

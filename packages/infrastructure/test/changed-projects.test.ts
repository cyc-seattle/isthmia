import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../../scripts/changed-projects");

function changedProjects(...paths: string[]): string {
  return execFileSync(script, { input: paths.join("\n"), encoding: "utf8" }).trim();
}

const all = "authentik portal";

describe("changed-projects", () => {
  it("deploys nothing for tests, features, and docs", () => {
    expect(
      changedProjects(
        "features/sign-in.feature",
        "test/features/support.ts",
        "packages/portal/test/render.test.ts",
        "docs/architecture.md",
        "packages/portal/README.md",
        "scripts/integration",
      ),
    ).toBe("");
  });

  it("deploys nothing for prod-only changes", () => {
    expect(
      changedProjects(
        "packages/infrastructure/src/authentik/Pulumi.prod.yaml",
        "packages/infrastructure/src/portal/Pulumi.prod.yaml",
      ),
    ).toBe("");
  });

  it("deploys a leaf project alone", () => {
    expect(changedProjects("packages/portal/src/site.ts")).toBe("portal");
  });

  it("deploys authentik and the portal behind it", () => {
    expect(changedProjects("packages/infrastructure/src/authentik/index.ts")).toBe("authentik portal");
    expect(changedProjects("scripts/wait-for-authentik")).toBe("authentik portal");
  });

  it("deploys everything for shared inputs and unknown paths", () => {
    expect(changedProjects("pnpm-lock.yaml")).toBe(all);
    expect(changedProjects("packages/infrastructure/src/cluster.ts")).toBe(all);
    expect(changedProjects(".github/workflows/pull-request.yml")).toBe(all);
    expect(changedProjects("something-new")).toBe(all);
  });
});

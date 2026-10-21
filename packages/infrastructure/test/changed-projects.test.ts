import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../../scripts/changed-projects");

function changedProjects(...paths: string[]): string {
  return execFileSync(script, { input: paths.join("\n"), encoding: "utf8" }).trim();
}

const all = "authentik crm portal clubspot-sync gsuite-sync";

describe("changed-projects", () => {
  it("deploys nothing for tests, features, and docs", () => {
    expect(
      changedProjects(
        "features/clubspot-sync.feature",
        "test/features/support.ts",
        "packages/clubspot-sync/test/people.test.ts",
        "docs/crm-schema.md",
        "packages/crm/README.md",
        "scripts/reset",
      ),
    ).toBe("");
  });

  it("deploys nothing for prod-only changes", () => {
    expect(
      changedProjects(
        "packages/infrastructure/src/infrastructure/dns.ts",
        "packages/infrastructure/src/crm/Pulumi.prod.yaml",
      ),
    ).toBe("");
  });

  it("deploys a leaf project alone", () => {
    expect(changedProjects("packages/portal/src/site.ts")).toBe("portal");
    expect(changedProjects("packages/clubspot-sync/src/main.ts")).toBe("clubspot-sync");
    expect(changedProjects("packages/infrastructure/src/gsuite-sync/index.ts")).toBe("gsuite-sync");
  });

  it("deploys crm and the syncs that read it for a schema change", () => {
    expect(changedProjects("packages/gsuite-sync/schema.yaml")).toBe("crm clubspot-sync gsuite-sync");
    expect(changedProjects("packages/directus/src/queue.ts")).toBe("crm clubspot-sync gsuite-sync");
  });

  it("deploys everything for authentik, which every other project reads", () => {
    expect(changedProjects("packages/infrastructure/src/authentik/index.ts")).toBe(all);
    expect(changedProjects("packages/infrastructure/src/directus/client.ts")).toBe(all);
  });

  it("deploys everything for shared inputs and unknown paths", () => {
    expect(changedProjects("pnpm-lock.yaml")).toBe(all);
    expect(changedProjects("packages/infrastructure/src/cluster.ts")).toBe(all);
    expect(changedProjects(".github/workflows/pull-request.yml")).toBe(all);
    expect(changedProjects("something-new")).toBe(all);
  });
});

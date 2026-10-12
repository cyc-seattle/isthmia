import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

interface Created {
  type: string;
  name: string;
  inputs: any;
}

const created: Created[] = [];
let StandardRepository: typeof import("../src/bootstrap/github.js").StandardRepository;

const ofType = (type: string) => created.filter((r) => r.type === type);
const byName = (name: string) => created.find((r) => r.name === name)!;

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    newResource: (args) => {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}_id`, state: args.inputs };
    },
    call: (args) => args.inputs,
  });
  // The module builds its resources on import, so it loads only after the mocks are set.
  ({ StandardRepository } = await import("../src/bootstrap/github.js"));
  new StandardRepository("example", { description: "An example.", requiredChecks: ["build"] });
  await new Promise((r) => setImmediate(r));
});

describe("StandardRepository", () => {
  it("allows squash merges only", () => {
    expect(byName("example").inputs).toMatchObject({
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
    });
  });

  it("deletes merged branches and turns the wiki off", () => {
    expect(byName("example").inputs).toMatchObject({ deleteBranchOnMerge: true, hasWiki: false });
  });

  it("names the repository after its resource and lets args override", () => {
    expect(byName("example").inputs).toMatchObject({ name: "example", description: "An example." });
  });

  it("requires a squash-only pull request on the default branch", () => {
    expect(byName("example-main").inputs).toMatchObject({
      name: "Require PRs and CI on main",
      conditions: { refName: { includes: ["~DEFAULT_BRANCH"] } },
      bypassActors: [{ actorType: "OrganizationAdmin", bypassMode: "always" }],
      rules: {
        deletion: true,
        nonFastForward: true,
        pullRequest: { requiredApprovingReviewCount: 0, allowedMergeMethods: ["squash"] },
      },
    });
  });

  it("requires each named status check", () => {
    expect(byName("example-main").inputs.rules.requiredStatusChecks.requiredChecks).toEqual([{ context: "build" }]);
  });

  it("blocks tag deletion and moves", () => {
    expect(byName("example-tags").inputs).toMatchObject({
      name: "Prevent Tag Deletion",
      target: "tag",
      rules: { deletion: true, nonFastForward: true },
    });
  });
});

describe("isthmia", () => {
  it("requires only checks that a job in the PR workflow reports", () => {
    const workflow = yaml.load(readFileSync(resolve(__dirname, "../../../.github/workflows/pr.yml"), "utf8")) as {
      jobs: Record<string, { name?: string }>;
    };
    const jobNames = Object.entries(workflow.jobs).map(([id, job]) => job.name ?? id);
    const main = ofType("github:index/repositoryRuleset:RepositoryRuleset").find((r) => r.name === "isthmia-main")!;
    const contexts: string[] = main.inputs.rules.requiredStatusChecks.requiredChecks.map(
      (c: { context: string }) => c.context,
    );
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(jobNames).toContain(context);
    }
  });
});

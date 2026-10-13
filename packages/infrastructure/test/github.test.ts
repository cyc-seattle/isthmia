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
  pulumi.runtime.setConfig("github:owner", "cyc-seattle");
  // The module builds its resources on import, so it loads only after the mocks are set.
  ({ StandardRepository } = await import("../src/bootstrap/github.js"));
  new StandardRepository("example", { description: "An example.", requiredChecks: ["build"] });
  new StandardRepository("archived-example", { description: "Archived.", archived: true, requiredChecks: ["build"] });
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

  it("squashes with the pull request's title and body", () => {
    expect(byName("example").inputs).toMatchObject({
      squashMergeCommitTitle: "PR_TITLE",
      squashMergeCommitMessage: "PR_BODY",
    });
  });

  it("allows auto-merge", () => {
    expect(byName("example").inputs).toMatchObject({ allowAutoMerge: true });
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

describe("StandardRepository labels, security, and reporting", () => {
  const labels = () => byName("example-labels").inputs.labels as { name: string; color: string; description: string }[];

  it("applies the standard labels to the repository", () => {
    expect(byName("example-labels").inputs.repository).toBe("example");
    expect(labels().map((l) => l.name)).toEqual(["P0", "P1", "P2", "P3"]);
    for (const label of labels()) {
      expect(label.color).toMatch(/^[0-9A-Fa-f]{6}$/);
      expect(label.description).not.toBe("");
    }
  });

  it("enables secret scanning and push protection", () => {
    expect(byName("example").inputs.securityAndAnalysis).toEqual({
      secretScanning: { status: "enabled" },
      secretScanningPushProtection: { status: "enabled" },
    });
  });

  it("leaves an archived repository's security settings to GitHub", () => {
    expect(byName("archived-example").inputs.securityAndAnalysis).toBeUndefined();
  });

  it("enables and disables private vulnerability reporting through gh", () => {
    const endpoint = "repos/cyc-seattle/example/private-vulnerability-reporting";
    expect(byName("example-private-vulnerability-reporting").inputs).toMatchObject({
      create: `gh api -X PUT ${endpoint}`,
      delete: `gh api -X DELETE ${endpoint}`,
    });
  });
});

describe("the org's repositories", () => {
  const repos = () => ofType("github:index/repository:Repository");

  it("gives each repository a unique name and a description", () => {
    const names = repos().map((r) => r.inputs.name);
    expect(new Set(names).size).toBe(names.length);
    for (const repo of repos()) {
      expect(repo.inputs.description).toBeTruthy();
    }
  });

  it("gives every repository created with autoInit a license", () => {
    for (const repo of repos().filter((r) => r.inputs.autoInit)) {
      expect(repo.inputs.licenseTemplate).toBeTruthy();
    }
  });
});

describe("Actions workflow permissions", () => {
  it("bars workflows from opening pull requests org-wide, with a read-only token", () => {
    expect(byName("org-workflow-permissions").inputs).toEqual({
      organizationSlug: "cyc-seattle",
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    });
  });

  it("bars workflows from opening pull requests in every repository", () => {
    const pins = ofType("github:index/workflowRepositoryPermissions:WorkflowRepositoryPermissions");
    expect(pins.length).toBe(ofType("github:index/repository:Repository").length);
    for (const pin of pins) {
      expect(pin.inputs).toMatchObject({ defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false });
    }
  });
});

describe("isthmia", () => {
  it("requires only checks that a job in the PR workflow reports", () => {
    const workflow = yaml.load(
      readFileSync(resolve(__dirname, "../../../.github/workflows/pull-request.yml"), "utf8"),
    ) as {
      jobs: Record<string, { name?: string; uses?: string }>;
    };
    const jobs = Object.entries(workflow.jobs);
    const jobNames = jobs.map(([id, job]) => job.name ?? id);
    // A job that calls a reusable workflow reports `<caller job> / <called job>`.
    const callers = jobs.filter(([, job]) => job.uses).map(([id, job]) => job.name ?? id);
    const main = ofType("github:index/repositoryRuleset:RepositoryRuleset").find((r) => r.name === "isthmia-main")!;
    const contexts: string[] = main.inputs.rules.requiredStatusChecks.requiredChecks.map(
      (c: { context: string }) => c.context,
    );
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      const caller = context.split(" / ")[0]!;
      expect(jobNames.includes(context) || (context.includes(" / ") && callers.includes(caller))).toBe(true);
    }
  });
});

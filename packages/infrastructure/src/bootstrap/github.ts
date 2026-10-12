import * as pulumi from "@pulumi/pulumi";
import * as github from "@pulumi/github";
import { local } from "@pulumi/command";

export type StandardRepositoryArgs = github.RepositoryArgs & {
  /** Job names from the repo's workflows. A name no job reports leaves every PR waiting. */
  requiredChecks: string[];
};

// No workflow token may open PRs, org-wide or per repo. Each repo's pin waits on the org policy.
const orgWorkflowPermissions = new github.ActionsOrganizationWorkflowPermissions("org-workflow-permissions", {
  organizationSlug: new pulumi.Config("github").require("owner"),
  defaultWorkflowPermissions: "read",
  canApprovePullRequestReviews: false,
});

/**
 * A GitHub repository with the org's standard settings: squash merges only, auto-merge allowed,
 * branches deleted on merge, no wiki, secret scanning with push protection, private vulnerability
 * reporting, the standard labels, `protect: true`, and archived rather than deleted on destroy. It
 * also protects `main` and the tags with rulesets. Pass `args` to override a setting for one
 * repository.
 */
export class StandardRepository extends github.Repository {
  constructor(
    plainId: string,
    { requiredChecks, ...args }: StandardRepositoryArgs,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(
      plainId,
      {
        name: plainId,
        hasIssues: true,
        hasWiki: false,
        hasDiscussions: false,
        allowMergeCommit: false,
        allowSquashMerge: true,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        squashMergeCommitTitle: "PR_TITLE",
        squashMergeCommitMessage: "PR_BODY",
        archiveOnDestroy: true,
        securityAndAnalysis: {
          secretScanning: { status: "enabled" },
          secretScanningPushProtection: { status: "enabled" },
        },
        ...args,
      },
      { protect: true, ...opts },
    );

    // Authoritative, and the deploy refreshes first, so a label added by hand is deleted.
    new github.IssueLabels(
      `${plainId}-labels`,
      {
        repository: this.name,
        labels: [
          { name: "P0", color: "B60205", description: "Critical priority" },
          { name: "P1", color: "D93F0B", description: "High priority" },
          { name: "P2", color: "FBCA04", description: "Medium priority" },
          { name: "P3", color: "0E8A16", description: "Low priority" },
        ],
      },
      { parent: this },
    );

    new github.WorkflowRepositoryPermissions(
      `${plainId}-workflow-permissions`,
      {
        repository: this.name,
        defaultWorkflowPermissions: "read",
        canApprovePullRequestReviews: false,
      },
      { parent: this, dependsOn: [orgWorkflowPermissions] },
    );

    // The provider has no input for private vulnerability reporting.
    const owner = new pulumi.Config("github").require("owner");
    const endpoint = `repos/${owner}/${plainId}/private-vulnerability-reporting`;
    new local.Command(
      `${plainId}-private-vulnerability-reporting`,
      { create: `gh api -X PUT ${endpoint}`, delete: `gh api -X DELETE ${endpoint}` },
      { parent: this, dependsOn: [this] },
    );

    new github.RepositoryRuleset(`${plainId}-main`, {
      name: "Require PRs and CI on main",
      repository: this.name,
      target: "branch",
      enforcement: "active",
      conditions: { refName: { includes: ["~DEFAULT_BRANCH"], excludes: [] } },
      bypassActors: [{ actorType: "OrganizationAdmin", bypassMode: "always" }],
      rules: {
        deletion: true,
        nonFastForward: true,
        pullRequest: {
          requiredApprovingReviewCount: 0,
          dismissStaleReviewsOnPush: true,
          allowedMergeMethods: ["squash"],
        },
        requiredStatusChecks: { requiredChecks: requiredChecks.map((context) => ({ context })) },
      },
    });

    new github.RepositoryRuleset(`${plainId}-tags`, {
      name: "Prevent Tag Deletion",
      repository: this.name,
      target: "tag",
      enforcement: "active",
      conditions: { refName: { includes: ["~ALL"], excludes: [] } },
      rules: { deletion: true, nonFastForward: true },
    });
  }
}

export const isthmia = new StandardRepository("isthmia", {
  description: "A collection of Typescript packages for managing CYC Community Sailing Center.",
  visibility: "public",
  hasProjects: true,
  requiredChecks: ["pr-check", "pr-title / pr-title"],
});

new StandardRepository(".github", {
  description:
    "Community health files, the org profile, reusable workflows, and the Renovate preset for cyc-seattle repos.",
  visibility: "public",
  autoInit: true,
  licenseTemplate: "apache-2.0",
  hasProjects: false,
  requiredChecks: ["ci / ci", "pr-title / pr-title"],
});

new StandardRepository("ts-config", {
  description: "Shared ESLint, Prettier, TypeScript, Vitest, and lefthook config for cyc-seattle repos.",
  visibility: "public",
  autoInit: true,
  licenseTemplate: "apache-2.0",
  hasProjects: false,
  requiredChecks: ["ci / ci", "pr-title / pr-title"],
});

new StandardRepository("agent-skills", {
  description: "Agent skills and sub-agents for cyc-seattle repos.",
  visibility: "public",
  autoInit: true,
  licenseTemplate: "apache-2.0",
  hasProjects: false,
  requiredChecks: ["ci / ci", "pr-title / pr-title"],
});

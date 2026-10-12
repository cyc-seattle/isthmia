import * as pulumi from "@pulumi/pulumi";
import * as github from "@pulumi/github";

export type StandardRepositoryArgs = github.RepositoryArgs & {
  /** Job names from the repo's workflows. A name no job reports leaves every PR waiting. */
  requiredChecks: string[];
};

/**
 * A GitHub repository with the org's standard settings: squash merges only, branches deleted on
 * merge, no wiki, `protect: true`, and archived rather than deleted on destroy. It also protects
 * `main` and the tags with rulesets. Pass `args` to override a setting for one repository.
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
        allowAutoMerge: false,
        deleteBranchOnMerge: true,
        squashMergeCommitTitle: "COMMIT_OR_PR_TITLE",
        squashMergeCommitMessage: "COMMIT_MESSAGES",
        archiveOnDestroy: true,
        ...args,
      },
      { protect: true, ...opts },
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
  requiredChecks: ["pr-check"],
});

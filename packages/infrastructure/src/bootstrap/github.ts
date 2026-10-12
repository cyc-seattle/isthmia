import * as github from "@pulumi/github";

export const isthmia = new github.Repository(
  "isthmia",
  {
    name: "isthmia",
    description: "A collection of Typescript packages for managing CYC Community Sailing Center.",
    visibility: "public",
    hasIssues: true,
    hasWiki: true,
    hasProjects: true,
    hasDiscussions: false,
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    allowAutoMerge: false,
    deleteBranchOnMerge: false,
    squashMergeCommitTitle: "COMMIT_OR_PR_TITLE",
    squashMergeCommitMessage: "COMMIT_MESSAGES",
    mergeCommitTitle: "MERGE_MESSAGE",
    mergeCommitMessage: "PR_TITLE",
    archiveOnDestroy: true,
  },
  { import: "isthmia", protect: true },
);

new github.RepositoryRuleset(
  "isthmia-main",
  {
    name: "PRs & conventional commits",
    repository: isthmia.name,
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
    },
  },
  { import: "isthmia:3692652" },
);

new github.RepositoryRuleset(
  "isthmia-tags",
  {
    name: "Prevent Tag Deletion",
    repository: isthmia.name,
    target: "tag",
    enforcement: "active",
    conditions: { refName: { includes: ["~ALL"], excludes: [] } },
    rules: { deletion: true, nonFastForward: true },
  },
  { import: "isthmia:3692715" },
);

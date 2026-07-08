---
name: work-issue
description: Drive a GitHub issue through the isthmia contribution workflow end to end — optional plan approval, branch, tests, implementation, local verification (just ci), PR, review feedback, and cleanup after a human merges. Use when the user says to work on / fix / implement an issue (e.g. "work issue 45", "start on #47").
---

# Work an Issue

End-to-end workflow for taking an isthmia issue from open to merged. This repo uses a **PR flow — direct pushes to `main` are not allowed.** Everything goes through a feature branch and pull request.

**The automation never merges.** A human reviewer approves by merging the PR themselves — that manual merge _is_ the approval. The loop's job is to open the PR, keep CI green, respond to review feedback with revisions, and then clean up once the human has merged.

## Prerequisites

- Working tree is clean (`git status`). If there are unrelated uncommitted changes, ask the user how to handle them before branching.
- On `main` and up to date: `git switch main && git pull`.

## Workflow

### 1. Understand the issue

`gh issue view <N>` (add `--comments` if there's discussion). Restate the goal and the acceptance criteria in a sentence. If the issue is unclear or a duplicate, stop and flag it (see the `triage` skill).

### 2. Plan (only if the issue needs one)

Not every issue needs a plan. **Skip** for small, unambiguous changes (a one-line fix, a doc tweak, an obvious test). **Write a plan** when the issue is complex, ambiguous, architectural, touches multiple packages, or has more than one reasonable approach.

When a plan is warranted:

1. Write it as a comment on the issue — the intended approach, the files/packages affected, and any trade-offs or open questions: `gh issue comment <N> --body "..."` (prefix it clearly, e.g. `## Proposed plan`).
2. Mark the issue for review: `gh issue edit <N> --add-label "plan-review"`.
3. **Wait for a human contributor to approve or amend the plan.** Poll the issue (`gh issue view <N> --json labels,comments`). The human signals:
   - **Approved** — they remove the `plan-review` label (their manual go-ahead). Proceed to step 3.
   - **Changes requested** — they leave a comment. Revise the plan, post the updated version as a new comment, and keep waiting (label stays on).
4. Do **not** start implementing until the plan is approved. Use the same backed-off cadence as the PR loop (step 9) while waiting.

### 3. Create a branch

Branch off `main`, named `<type>/<issue#>-<slug>`, matching the issue's type label:

```sh
git switch -c fix/45-duplicate-events   # bug
git switch -c feat/47-auth-reconcile    # enhancement
git switch -c docs/21-readme-auth        # documentation
```

### 4. Write tests first (for bugs and testable logic)

Reproduce the bug with a failing test before fixing it. Tests live at `packages/<pkg>/test/**/*.test.ts` and run under vitest. Mock the external SDK boundary (Parse, google-spreadsheet, googleapis) — see `packages/gsuite/test/spreadsheet.test.ts` for the pattern. Run just the affected package's tests while iterating: `vitest run packages/<pkg>`.

### 5. Implement

Make the change. Match surrounding style: strict TypeScript, ESM with `.js` import extensions, imperative-capitalized commit subjects. Keep the diff scoped to the issue.

### 6. Verify locally

- Full gate (matches CI): `just ci` (install → build → check → test).
- Faster inner loop: `just check` (treefmt + eslint) and `just test`.
- For behavior that needs real Google/Clubspot access, verify with a manual run where feasible (see CLAUDE.md auth model) or clearly state in the PR what could only be tested via mocks.
- Pre-commit hooks (treefmt, eslint) run on commit — `just check` first avoids surprises.

### 7. Commit

Imperative, capitalized subject matching repo history (no conventional-commit prefixes). Reference the issue in the body:

```sh
git commit -m "Write new event ID back to sheet on recreate" -m "Fixes #45"
```

### 8. Push, open the PR, and request review

```sh
git push -u origin HEAD
gh pr create --fill --base main
```

- Ensure the PR body links the issue with a closing keyword (`Closes #45`) so the merge auto-closes it.
- Request review from the human reviewer(s) so the PR shows up in their queue: `gh pr edit <N> --add-reviewer <login>`.
- Post a short comment making the hand-off explicit: _"Ready for review. Merge it yourself when you're happy — that's the approval. I'll keep CI green and address any review comments."_
- Then enter the automated review loop (step 9).

### 9. Automated review loop (never merges)

Poll the PR on a cadence until the human merges it or closes it. Each cycle, gather state:

```sh
gh pr view <N> --json state,mergeStateStatus,statusCheckRollup,reviews,comments
```

Then act on it:

- **Merged by a human:** `state == "MERGED"` → go to step 10 (cleanup). This is the approval signal.
- **Closed without merging:** `state == "CLOSED"` → stop the loop and report; don't reopen or re-push.
- **CI red / failing checks:** get the failure (`gh run view <run-id> --log-failed`), fix on the branch, commit, push. To be woken when a run finishes rather than polling blindly, run `gh pr checks <N> --watch` in the background.
- **Changes requested or actionable review comments:** address each with commits on the same branch, push, and reply to the threads noting what changed. Don't force-push over review history unless asked. This is a _revision_ — the loop continues.
- **Green and waiting:** nothing to do — the PR is the human's to merge. Wait and re-check.

**Never run `gh pr merge`.** The automation keeps the PR healthy; the human presses merge.

**Cadence (use `ScheduleWakeup`):** while CI is actively running, check on a short interval (a few minutes). While idle waiting for the human to merge, back off to ~20–30 min so you don't burn cycles. Stop looping if the PR is merged or closed.

### 10. Clean up after the human merges

```sh
git switch main && git pull
git branch -d <branch>   # delete the local feature branch (remote branch is deleted at merge time or by GitHub)
```

Confirm the issue closed (the `Closes #N` keyword handles it). Report the merged PR and closed issue back to the user.

## Guardrails

- Never push directly to `main`. **Never merge PRs** — the human reviewer merges manually; that manual merge is the approval. The automation only opens the PR, keeps CI green, and addresses feedback.
- For issues that needed a plan (step 2), don't start implementing until the `plan-review` label is removed (plan approved).
- Keep one issue per branch/PR. If you discover unrelated problems, capture them as new issues (see the `capture` skill) rather than expanding scope.
- If CI keeps failing after a couple of honest fix attempts, or a review asks for something ambiguous, stop the loop and ask the user rather than guessing.

---
name: work-issue
description: Drive a GitHub issue through the isthmia contribution workflow end to end — branch, tests, implementation, local verification (just ci), PR, review feedback, merge, and branch cleanup. Use when the user says to work on / fix / implement an issue (e.g. "work issue 45", "start on #47").
---

# Work an Issue

End-to-end workflow for taking an isthmia issue from open to merged. This repo uses a **PR flow — direct pushes to `main` are not allowed.** Everything goes through a feature branch and pull request.

## Prerequisites

- Working tree is clean (`git status`). If there are unrelated uncommitted changes, ask the user how to handle them before branching.
- On `main` and up to date: `git switch main && git pull`.

## Workflow

### 1. Understand the issue

`gh issue view <N>` (add `--comments` if there's discussion). Restate the goal and the acceptance criteria in a sentence. If the issue is unclear or a duplicate, stop and flag it (see the `triage` skill).

### 2. Create a branch

Branch off `main`, named `<type>/<issue#>-<slug>`, matching the issue's type label:

```sh
git switch -c fix/45-duplicate-events   # bug
git switch -c feat/47-auth-reconcile    # enhancement
git switch -c docs/21-readme-auth        # documentation
```

### 3. Write tests first (for bugs and testable logic)

Reproduce the bug with a failing test before fixing it. Tests live at `packages/<pkg>/test/**/*.test.ts` and run under vitest. Mock the external SDK boundary (Parse, google-spreadsheet, googleapis) — see `packages/gsuite/test/spreadsheet.test.ts` for the pattern. Run just the affected package's tests while iterating: `vitest run packages/<pkg>`.

### 4. Implement

Make the change. Match surrounding style: strict TypeScript, ESM with `.js` import extensions, imperative-capitalized commit subjects. Keep the diff scoped to the issue.

### 5. Verify locally

- Full gate (matches CI): `just ci` (install → build → check → test).
- Faster inner loop: `just check` (treefmt + eslint) and `just test`.
- For behavior that needs real Google/Clubspot access, verify with a manual run where feasible (see CLAUDE.md auth model) or clearly state in the PR what could only be tested via mocks.
- Pre-commit hooks (treefmt, eslint) run on commit — `just check` first avoids surprises.

### 6. Commit

Imperative, capitalized subject matching repo history (no conventional-commit prefixes). Reference the issue in the body:

```sh
git commit -m "Write new event ID back to sheet on recreate" -m "Fixes #45"
```

### 7. Push, open the PR, and request review

```sh
git push -u origin HEAD
gh pr create --fill --base main
```

- Ensure the PR body links the issue with a closing keyword (`Closes #45`) so merge auto-closes it.
- **Request review.** The approver is the author (ungood), who can't formally "Approve" their own PR on GitHub, so approval is signalled by adding the **`approved` label** to the PR. Post a short comment telling the author the PR is ready and how to approve: _"Ready for review — add the `approved` label (or comment `/approve`) once you're happy and I'll auto-merge on green CI."_ (If a second set of eyes is wanted for a specific PR, also `gh pr edit <N> --add-reviewer argold57`.)
- Then enter the automated review loop (step 8).

### 8. Automated review loop

Poll the PR on a cadence until it is mergeable or closed. Each cycle, gather state:

```sh
gh pr view <N> --json state,mergeable,reviewDecision,labels,statusCheckRollup,reviews,comments
```

Then act on it:

- **CI red / failing checks:** get the failure (`gh run view <run-id> --log-failed`), fix on the branch, commit, push. To be woken when a run finishes rather than polling blindly, run `gh pr checks <N> --watch` in the background.
- **Changes requested or actionable review comments:** address each with commits on the same branch, push, and reply to the threads noting what changed. Don't force-push over review history unless asked. This is a _revision_ — the loop continues.
- **Not yet approved:** the `approved` label is absent (and, if a human reviewer was requested, `reviewDecision != APPROVED`). Nothing to do yet — schedule the next check and wait.
- **Approved AND CI green:** proceed to step 9 and merge automatically (no confirmation needed — the label is the go-ahead).

**Cadence (use `ScheduleWakeup`):** while CI is actively running, check on a short interval (a few minutes). While idle waiting on the human `approved` label, back off to ~20–30 min so you don't burn cycles. Stop looping if the PR is closed/merged externally.

### 9. Merge and clean up (automatic)

Once approved + green:

```sh
gh pr merge <N> --squash --delete-branch
git switch main && git pull
git branch -d <branch>   # if the local branch lingers
```

Confirm the issue closed (the `Closes #N` keyword handles it). Report the merged PR and closed issue back to the user.

## Guardrails

- Never push directly to `main`. Never merge unless CI is green **and** the `approved` label is present.
- The `approved` label is the only auto-merge trigger. Absent it, keep looping — don't merge on green CI alone.
- Keep one issue per branch/PR. If you discover unrelated problems, capture them as new issues (see the `capture` skill) rather than expanding scope.
- If CI keeps failing after a couple of honest fix attempts, or a review asks for something ambiguous, stop the loop and ask the user rather than guessing.

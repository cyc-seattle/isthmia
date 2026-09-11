---
name: end-session
description: Close a work session — run the full CI gate, review the diff, and open one pull request for the whole batch. Use when the user says the session is done, they are happy with the batch, or "ship it".
---

# End a Session

Turn the session branch into one pull request. The human merges it, and that merge is the approval.

## 1. Check the tree

Run `git status --short`. The tree must be clean.

If work is uncommitted, ask the user whether to commit it or drop it. Do not open a PR over a dirty tree.

## 2. Run the full gate

```sh
just ci
```

This runs install, build, check, and test — the same gate as the GitHub Actions `pr.yml` workflow.

If it fails, fix it through `implement` so the fix gets its own commit. Do not open a PR on a red gate unless the user tells you to.

## 3. Review the diff

Run the `review` skill. Report the findings to the user.

The user decides what to fix now and what to capture as an issue. Fix through `implement`. After any fix, run `just ci` again.

## 4. Open the pull request

```sh
git push -u origin HEAD
gh pr create --base main --title "<summary of the batch>" --fill
```

Write the body from the session task list. One bullet per task, in the order they were done.

```markdown
## Changes

- <task 1>
- <task 2>

## Verification

`just ci` passes. Reviewed with the `review` skill.
```

Add `Closes #N` only for tasks that had a real issue. Most sessions have none.

Request a review only when someone other than the author can give one. GitHub rejects a request for review from yourself, and this repo usually has one maintainer.

```sh
gh pr edit <N> --add-reviewer <login>
```

## 5. Hand off

Give the user the PR URL. Tell them the PR is theirs to merge.

**Never run `gh pr merge`.** Keep CI green and answer review comments. The human presses merge.

If CI fails after the push, or a review asks for a change, fix it on the same branch through `implement` and push again.

## 6. Clean up after the merge

Wait for the human to merge. Do not clean up a session whose PR is still open — the worktree is the only copy of that branch's working state.

Once it is merged:

1. Leave the worktree with `ExitWorktree`.
2. Remove it and the merged branch from the main checkout:

   ```sh
   git worktree remove .claude/worktrees/<slug>
   git branch -d session/<slug>
   git fetch --prune
   ```

3. Confirm that any issue with a `Closes` keyword actually closed.

Removing the worktree deletes its `node_modules`. That is fine — the next session installs its own.

If `git worktree remove` refuses because the tree is dirty, stop and show the user what is uncommitted. Never pass `--force` without asking.

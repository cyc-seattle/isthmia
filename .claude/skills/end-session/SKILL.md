---
name: end-session
description: Close a work session — run the full CI gate, open one pull request for the whole batch, review the diff, and end with the list of what the user must do. Use when the user says the session is done, they are happy with the batch, or "ship it".
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

## 3. Open the pull request

Open it as soon as the gate is green, before the review runs. The human then reads the diff in
parallel with the `review` sub-agent instead of waiting on it.

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

`just ci` passes. Review in progress.
```

Say what the gate actually proved, and name what it could not. A change that needs a deploy, a
schema apply, or a live credential stays unverified until a human does it — call that out here
rather than letting a green `just ci` imply more than it does.

Add `Closes #N` only for tasks that had a real issue. Most sessions have none.

Request a review only when someone other than the author can give one. GitHub rejects a request
for review from yourself, and this repo usually has one maintainer.

```sh
gh pr edit <N> --add-reviewer <login>
```

## 4. Review the diff

Run the `review` skill against the branch. Report the findings to the user, and post anything
substantive to the PR so the review and the human's own reading meet in one place.

The user decides what to fix now and what to capture as an issue. Fix through `implement`. After
any fix, run `just ci` again and push to the same branch.

## 5. Hand off

**Never run `gh pr merge`.** Keep CI green and answer review comments. The human presses merge.

If CI fails after the push, or a review asks for a change, fix it on the same branch through `implement` and push again.

### Always end the session with this block

The last thing in your final message is the handoff block below — nothing after it, no sign-off,
no summary of what you did. The user should never scroll back to find what you need from them.

```markdown
## Over to you

<PR URL>

1. Merge the PR — that is the approval.
2. <each manual step, one line, imperative>
3. <each open question you could not decide>
```

Number the list so the user can answer by item ("2: done, 4: skip"). Never use checkboxes.

Rules for the list:

- **Only things the user must do.** Not what you did, not what a follow-up session will do.
- **One line each, imperative**, starting with the verb. "Assign the Groups Administrator role in
  the Admin console (`docs/manual-setup.md` §5.4)."
- **Anything a green `just ci` did not prove** goes here: a deploy, a schema apply, a live
  credential, a manual console step, an API whose behavior is unconfirmed.
- **Every question you put to the user with `AskUserQuestion` and never got an answer to** goes
  here, with the decision you made in the meantime, so silence does not read as agreement. This
  list is not where a question gets asked for the first time — if it blocks something, you should
  have prompted when you found it. A question that only ever appeared in ordinary output was never
  asked, and writing it here does not make it so.
- Say where each step is documented, so the user is not hunting.
- If the list is empty except the merge, say so in one line rather than padding it.

Emit this block even when the session ends early, is interrupted, or ends without a PR. If there is
no PR, say what state the branch is in and what it needs.

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

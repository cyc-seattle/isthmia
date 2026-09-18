---
name: start-session
description: Open a work session — create the session branch, then triage each request the user makes into one of three tiers and dispatch it. Stays responsive between tasks. Use when the user starts a work session, says "let's work on some things", or begins a batch of changes meant to land as one PR.
---

# Start a Session

Entry point for the isthmia workflow. A **session** is one git worktree, one branch, one batch of work, and one pull request at the end.

Your job is to orchestrate, not to disappear into a task. The user treats this session like a browser main thread. Keep it free.

## Companion skills

Each step of the workflow is its own skill. Call them, do not re-implement them.

| Skill               | When                                            |
| ------------------- | ----------------------------------------------- |
| `capture`           | File a GitHub issue                             |
| `triage`            | Clean up the issue backlog                      |
| `design`            | Tier 3 — write a design doc and get it approved |
| `implement`         | Tier 2 and 3 — brief and dispatch a sub-agent   |
| `review`            | Review the session diff                         |
| `end-session`       | Verify, review, and open the PR                 |
| `technical-writing` | Any prose you write                             |

## 1. Open the session

Every session runs in its own **git worktree**. The user runs sessions in parallel in separate terminals, and a worktree is what keeps them from fighting over one working tree.

Do this once, at the start.

1. **Check where you are.** Run `git status --short` and `git branch --show-current`.
   - Already in a session worktree — use it. Do not nest worktrees.
   - The tree is dirty with unrelated changes — ask the user what to do first.
   - On a branch that is not `main` in the main checkout — ask whether to continue there or open a fresh worktree.

2. **Pick a name.** Propose a short slug for the work, such as `roster-reports` or `auth-cleanup`. Fall back to `session-YYYY-MM-DD` when the session has no theme yet. Confirm it with the user.

3. **Create the worktree and the branch together**, so the branch gets a real name:

   ```sh
   git fetch origin
   git worktree add .claude/worktrees/<slug> -b session/<slug> origin/main
   ```

   Then enter it with `EnterWorktree`, passing `path: .claude/worktrees/<slug>`.

   Creating the worktree with `EnterWorktree`'s `name` argument also works, but it names the branch `worktree-<slug>`, which reads badly in the pull request.

4. **Set the worktree up** with `just worktree` — git hooks, then dependencies.

   A `SessionStart` hook runs this already, so usually there is nothing to do. Run it by hand if
   the hook did not fire, or if a commit fails with "No .pre-commit-config.yaml file was found".

5. **Start a task list** with `TodoWrite`. It becomes the PR body at the end of the session.

6. Tell the user the session is open and name the worktree path. They can now describe tasks one at a time.

Never repeat this step. One worktree and one branch per session.

## 2. Triage each request into a tier

The user describes something they want. Decide how big it is **before** you touch anything. Read the relevant code first — a two-minute read prevents a wrong tier.

State the tier you chose in one line, then act. Do not ask the user to confirm the tier. If you get it wrong, change tiers mid-task and say so.

### Tier 1 — do it inline

The change is small, obvious, and local. One or two files. No design choice to make.

Examples: a typo, a rename, a wrong constant, a missing `.js` import extension, a doc tweak, a one-line bug fix with an obvious cause.

Do it yourself, now. Run `just check`. Commit it. Report in two lines. Dispatching a sub-agent for this costs more than doing it.

### Tier 2 — clarify, then dispatch

The change is real work but the approach is not in doubt. It touches one package, or several files in a clear pattern.

Examples: add a test suite for a module, fix a bug that needs a regression test, refactor a function and its callers, add a CLI flag.

1. Ask only the questions whose answers change the work. Zero questions is common. Cap it at one round.
2. Find the exact `path:line` anchors yourself.
3. Call `implement` to brief and dispatch the sub-agent.
4. Stay available while it runs.

### Tier 3 — design first

The change needs a decision, spans packages, touches infrastructure or auth, or deserves more than one review cycle.

Examples: a new package, a schema change, an auth model change, anything in `packages/infrastructure` that changes topology.

1. Call `design`. It writes a doc to `.claude/plans/` and waits for the user to approve it.
2. File an issue with `capture` **only if** the work will span more than this session. Otherwise the design doc is enough.
3. After approval, call `implement` once per implementation step.

Tier 3 work lands on the session branch like everything else. It does not get its own PR.

## 3. Stay responsive

Dispatch sub-agents in parallel when their file sets are disjoint — a `designer` writing only to
`.claude/plans/` can never collide with an `implementer` writing to `packages/`, and two
implementers in different packages are usually safe. Serialize anything that touches the same file
or the same package, and always serialize `packages/crm/schema.yaml` — it is a frequent collision
point.

The worktree isolates this session from the user's _other_ sessions. It does not isolate your
sub-agents from each other, and the git index is the real shared resource: every agent must stage
its own explicit paths, never `-A` or `.`, or one agent commits another's unfinished work.

While a sub-agent runs, you are still free. Do this:

- Answer the user's questions, read code, and explain things.
- Plan the next task and find its anchors.
- Run read-only commands.
- Dispatch read-only research sub-agents (`Explore`) if it helps.
- Dispatch another writing sub-agent whose files are disjoint from ones already running.

Do not do this:

- Edit a file or commit yourself. Queue that work and say it is queued.
- Dispatch a second writing sub-agent whose files overlap one already running.

When the sub-agent returns, run `git show --stat HEAD`, read the diff if it is non-trivial, and give the user a short summary. Tick the task off the list.

If the work is wrong, dispatch a follow-up sub-agent or revert the commit. Do not patch it by hand.

## 4. End the session

When the user says they are done, call `end-session`.

## Guardrails

- One worktree, one branch, one PR.
- **Never run bare `git stash`.** The stash stack is shared with every other worktree and every parallel session. A `git stash pop` here can swallow another session's work. Make a temporary commit instead.
- Never push to `main`. Never merge a PR. The human merges, and that merge is the approval.
- Keep each commit scoped to one task, so a bad one can be reverted on its own.
- Unrelated problems found mid-task — tell the user or run `capture`. Never widen the diff.
- If a tier-2 task turns out to need a design decision, stop it and move to tier 3.

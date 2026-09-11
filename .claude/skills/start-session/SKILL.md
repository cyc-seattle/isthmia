---
name: start-session
description: Open a work session — create the session branch, then triage each request the user makes into one of three tiers and dispatch it. Stays responsive between tasks. Use when the user starts a work session, says "let's work on some things", or begins a batch of changes meant to land as one PR.
---

# Start a Session

Entry point for the isthmia workflow. A **session** is one branch, one batch of work, and one pull request at the end.

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

Do this once, at the start.

1. Run `git status --short` and `git branch --show-current`.
   - The tree is dirty with unrelated changes — ask the user what to do first.
   - The current branch is not `main` — offer to use it as the session branch.
   - The current branch is `main` — run `git pull`, propose `session/YYYY-MM-DD`, confirm the name, then run `git switch -c <branch>`.
2. Start a task list with `TodoWrite`. It becomes the PR body at the end of the session.
3. Tell the user the session is open. They can now describe tasks one at a time.

Never repeat this step. One branch per session.

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

One sub-agent writes to the tree at a time. Two concurrent writers will collide on a shared branch.

While a sub-agent runs, you are still free. Do this:

- Answer the user's questions, read code, and explain things.
- Plan the next task and find its anchors.
- Run read-only commands.
- Dispatch read-only research sub-agents (`Explore`) if it helps.

Do not do this:

- Edit a file, commit, or dispatch a second writing sub-agent. Queue that work and say it is queued.

When the sub-agent returns, run `git show --stat HEAD`, read the diff if it is non-trivial, and give the user a short summary. Tick the task off the list.

If the work is wrong, dispatch a follow-up sub-agent or revert the commit. Do not patch it by hand.

## 4. End the session

When the user says they are done, call `end-session`.

## Guardrails

- One branch, one PR, one writer at a time.
- Never push to `main`. Never merge a PR. The human merges, and that merge is the approval.
- Keep each commit scoped to one task, so a bad one can be reverted on its own.
- Unrelated problems found mid-task — tell the user or run `capture`. Never widen the diff.
- If a tier-2 task turns out to need a design decision, stop it and move to tier 3.

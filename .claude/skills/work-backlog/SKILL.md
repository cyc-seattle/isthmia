---
name: work-backlog
description: Orchestrate working through the isthmia issue backlog — triage, pick the highest-priority actionable issue, and delegate it to a sub-agent that runs the work-issue workflow. Handles one issue at a time (no parallel work). Use when the user says to work the backlog, work through issues, or "orchestrate issues".
---

# Work the Backlog

Top-level orchestrator that turns the open issue backlog into merged PRs. It does **not** write code itself — it triages, decides what's next, and delegates each issue to a sub-agent running the `work-issue` skill. It owns the long waits (plan approval, human merge) that a one-shot sub-agent can't sit through.

## Constraints

- **One issue in flight at a time.** Never start a second issue until the current one's PR is merged or closed. Exactly one active branch/PR — no parallel work (for now).
- **Never merge.** Humans merge PRs manually; that's the approval (see `work-issue`).

## Workflow

### 1. Triage first

Run the `triage` skill so every open issue has a type + priority label, duplicates are resolved, and unclear issues are flagged. A clean, prioritized backlog is the input to selection.

### 2. Build the work queue

Order actionable issues by priority (`P0` → `P3`, then oldest first). **Exclude** issues that aren't ready:

- Blocked on a human: `plan-review` label present, or the body says it depends on another issue ("land #X first").
- Ambiguous / needs a decision (flagged during triage).
- Already in progress: an open PR or branch already references it.

Show the user the resulting queue and the issue you intend to start. Proceed with the top item unless it needs a decision only the user can make — then ask first.

### 3. Delegate one issue to a sub-agent

Spawn a sub-agent (`Agent`, `subagent_type: general-purpose`) to run the `work-issue` skill for the chosen issue. Give it a **bounded** unit of work and a clear return contract — it must not block waiting on humans.

Prompt the sub-agent to:

- Read issue `#N`, then invoke the `work-issue` skill and follow it.
- Do the hands-on work: plan-if-needed, branch, tests-first, implement, `just ci`, commit, push, open the PR (with `Closes #N`), request review, and get CI green.
- **Not** wait for plan approval or for the human to merge. Instead, return a status:
  - `AWAITING_PLAN_APPROVAL` — the issue needed a plan; it posted the plan + `plan-review` label and stopped.
  - `PR_OPEN` — PR is open and CI is green, handed off for the human to merge. Include the PR number/URL.
  - `BLOCKED` — couldn't proceed (CI won't go green, ambiguous requirement, etc.). Include why.
- Report back: issue #, branch, PR #/URL, final status, and notes.

### 4. Handle the gate the sub-agent stopped at

- **`AWAITING_PLAN_APPROVAL`** — wait for a human to approve the plan (remove the `plan-review` label) or comment changes. Poll on a backed-off cadence (see below). Once approved, dispatch a fresh sub-agent to implement it. Don't start a different issue meanwhile.
- **`PR_OPEN`** — watch the PR (background `gh pr checks --watch` and periodic polls). If CI later fails or a review requests changes, dispatch a follow-up sub-agent to push a revision. When the human merges, run the `work-issue` cleanup (delete local branch, `git switch main && git pull`) and mark the issue done.
- **`BLOCKED`** — stop and surface it to the user; don't guess.

**Cadence (`ScheduleWakeup`):** short interval (a few minutes) while CI is running; back off to ~20–30 min while waiting on a human (plan approval or merge). Prefer being woken by a backgrounded `gh pr checks --watch` over blind polling.

### 5. Advance the queue

Once the current issue's PR is merged (or closed), return to step 2 and pick the next. Stop when the queue is empty or the user says to stop, and report a summary (issues completed, PRs merged, anything left blocked).

## Notes

- Selection is driven entirely by the labels the `triage` skill maintains — keep them accurate.
- Sub-agents start cold: point them at the issue and let them read `work-issue`/`triage`/`capture` and `CLAUDE.md` for conventions rather than re-explaining everything.
- This orchestrator is the only place that sequences issues; each sub-agent only ever knows about its single issue.

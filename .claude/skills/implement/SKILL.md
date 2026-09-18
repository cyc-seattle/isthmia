---
name: implement
description: Brief and dispatch a Sonnet sub-agent to make one scoped code change on the current branch, then review what it did. Use for any task too large to do inline, and for each implementation step of an approved design.
---

# Implement a Task

Hand one scoped change to a sub-agent. The sub-agent edits, verifies, and commits. You review the result.

The sub-agent starts cold. It knows nothing about the session, the previous tasks, or the conversation. Everything it needs goes in the brief.

## 1. Prepare the brief

Find the exact `path:line` anchors yourself before you write the brief. A brief that names a file and a line is worth far more than one that describes a symptom.

## 2. Dispatch

Use `Agent` with `subagent_type: implementer`.

The agent already knows the conventions, the test pattern, the `just` rules, and the git rules — they are in `.claude/agents/implementer.md`. Do not repeat them. The brief carries only what is specific to this task:

**Task.** What to change, concretely, with `path:line` anchors.

**Scope fence.** The exact boundary of this change. Name anything adjacent it must not touch.

**Context it cannot derive.** A decision already made, a constraint from the design doc, a reason the obvious approach is wrong. If an approved design doc covers this step, give its path and the step number.

**Never ask for a comment.** Give the agent the constraint and let the standing rule in `CLAUDE.md` decide whether it earns a comment. A brief that says "leave a comment explaining why" overrides that rule, and the agent will write five lines where none were needed.

**Acceptance.** How to know the change worked — the behavior that should differ, or the test that should now pass.

## 3. Review the result

1. Run `git show --stat HEAD`. Read the full diff if the change is non-trivial.
2. Check that the diff stayed inside the scope fence.
3. Summarize for the user in two or three lines: what changed, whether the checks passed, and anything the sub-agent flagged.

If the work is wrong or too wide, dispatch a follow-up sub-agent or run `git revert`. Do not patch it by hand — that defeats the point of delegating.

## Rules

- Dispatch sub-agents in parallel only when their file sets are disjoint. Serialize anything
  touching the same file, the same package, or `packages/crm/schema.yaml`.
- Every agent stages explicit paths, never `-A` or `.` — the git index is shared, and a sweep
  commits another agent's unfinished work.
- One commit per task. A bad task can then be reverted without unpicking the batch.
- If the sub-agent reports the task is bigger than described, stop and move it to `design`.
- If `just check` or `just test` will not pass after two honest attempts, stop and ask the user.

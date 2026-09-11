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

Use `Agent` with `subagent_type: general-purpose` and `model: sonnet`. Include every section below.

**Task.** What to change, concretely, with `path:line` anchors.

**Scope fence.** Only this change. Report anything else you notice — do not fix it.

**Conventions.** Read `CLAUDE.md` first. Strict TypeScript. ESM with `.js` import extensions. Match the surrounding style. For prose and comments, follow the `technical-writing` skill and the comment policy in `CLAUDE.md`.

**Tests.** For a bug with testable logic, write the failing test first. Tests live at `packages/<pkg>/test/**/*.test.ts`. Mock the external SDK boundary — Parse, google-spreadsheet, googleapis. See `packages/gsuite/test/spreadsheet.test.ts` for the pattern.

**Verify with `just` recipes only.** Run `just check` and `just test`. Do not call `vitest`, `eslint`, or `treefmt` directly. If a recipe is missing, say so instead of working around it.

**Git rules.** Commit to the current branch. One commit. Imperative, capitalized subject, no conventional-commit prefix. Never create a branch, switch branches, push, or open a PR.

**Report back.** The commit subject and SHA. The files touched. Whether `just check` and `just test` passed. Anything noticed but deliberately left alone.

## 3. Review the result

1. Run `git show --stat HEAD`. Read the full diff if the change is non-trivial.
2. Check that the diff stayed inside the scope fence.
3. Summarize for the user in two or three lines: what changed, whether the checks passed, and anything the sub-agent flagged.

If the work is wrong or too wide, dispatch a follow-up sub-agent or run `git revert`. Do not patch it by hand — that defeats the point of delegating.

## Rules

- One writing sub-agent at a time. Two will collide on the shared working tree.
- One commit per task. A bad task can then be reverted without unpicking the batch.
- If the sub-agent reports the task is bigger than described, stop and move it to `design`.
- If `just check` or `just test` will not pass after two honest attempts, stop and ask the user.

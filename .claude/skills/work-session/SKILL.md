---
name: work-session
description: Run a fast, interactive batch of small fixes and cleanups on a single shared branch, delegating each one to a Sonnet sub-agent and opening one PR for the whole batch at the end. Use when the user wants to knock out small tasks quickly ("work session", "let's clean some things up", "quick fixes") rather than drive a formal issue through work-issue.
---

# Work Session

A lightweight loop for knocking out **small** tasks — fixes, cleanups, renames, doc tweaks, papercuts. The user describes a task in a sentence; you clarify only what's genuinely ambiguous, hand the task to a sub-agent, and report back. Repeat until the user calls the batch done, then open **one** PR for everything.

This is deliberately lighter than `work-issue` / `work-backlog`: **no issues, no plan approval, no per-task PR, one branch for the whole session.** If a task turns out to need any of that, stop and hand it off (see [Escalation](#escalation)).

## Roles

- **You (primary, Opus).** Own the session: the branch, the task list, clarification, review of each sub-agent's diff, and the final PR. **You do not write the code.** If you catch yourself editing a source file, you've taken the sub-agent's job.
- **Sub-agent (Sonnet).** One per task. Gets a self-contained brief, makes the change, verifies it, commits it, and reports. Starts cold every time — it knows nothing about the session or prior tasks.

The user should be on Opus for this (`/model opus`); a skill can't set that. Mention it once if the session feels like it's running on a smaller model.

## 1. Open the session

Do this once, at the start.

1. **Check the working tree.** `git status --short` and `git branch --show-current`.
   - Dirty tree with unrelated changes → ask the user what to do before touching anything.
   - Already on a non-`main` branch → offer to use it as the session branch.
   - On `main` → `git pull`, then propose `chore/session-YYYY-MM-DD` (today's date). Confirm the name, then `git switch -c <branch>`.
2. **Start a task list** (`TodoWrite`) and keep it current — it's the source for the PR body later.
3. Tell the user you're ready and that they can just describe tasks one at a time.

Never re-do this step mid-session. One branch for the whole batch.

## 2. The loop

For each task the user describes:

### a. Clarify — briefly

Ask only questions whose answers would change the work. **Zero questions is the common case.** If you can resolve it by reading the code, read the code instead of asking. Cap it at one round; don't interview the user about a two-line change.

Do a quick read yourself (`grep`, `sed -n`) to pin down the file and line before delegating — a brief that names `path:line` is worth far more than one that describes a symptom.

### b. Delegate

Spawn **one** sub-agent per task: `Agent` with `subagent_type: general-purpose` and `model: sonnet`. Its brief must be self-contained:

- **What to change**, concretely, with `path:line` anchors you already found.
- **Scope fence:** only this change, nothing else. Unrelated problems get reported back, not fixed.
- **Conventions:** read `CLAUDE.md`. Strict TypeScript, ESM with `.js` import extensions, match surrounding style.
- **Tests:** if it's a bug with testable logic, write the failing test first. Tests live at `packages/<pkg>/test/**/*.test.ts`; mock the external SDK boundary (Parse, google-spreadsheet, googleapis) — see `packages/gsuite/test/spreadsheet.test.ts`.
- **Verify with `just` recipes only** — `just check` and `just test`. Do not invoke `vitest`, `eslint`, or `treefmt` directly; if a recipe is missing, say so rather than reaching around it.
- **Commit on the current branch**, one commit, imperative capitalized subject, no conventional-commit prefix. **Do not** create a branch, switch branches, push, or open a PR.
- **Report back:** the commit subject + SHA, files touched, whether `just check` and `just test` passed, and anything it noticed but deliberately left alone.

Run tasks **one at a time**. They share a branch and a working tree; two sub-agents editing at once will collide.

### c. Review and report

When the sub-agent returns: `git show --stat HEAD` (and the full diff if it's non-trivial). Give the user a two-or-three-line summary — what changed, whether checks passed, anything the sub-agent flagged. Tick the task off the list.

If the sub-agent's work is wrong or overreached, fix it by dispatching a follow-up sub-agent, or `git revert`/`git reset` the commit — don't patch it yourself.

Then wait for the next task.

## 3. Close the batch

When the user says they're happy / done / "ship it":

1. `just ci` — the full gate (install → build → check → test). Fix anything red via a sub-agent before continuing.
2. `git push -u origin HEAD`
3. `gh pr create --base main --title "<short summary of the batch>" --body "..."` — the body is a bulleted changelog, one line per task, in the order they were done. No `Closes #N` unless a task happened to correspond to a real issue.
4. Report the PR URL. **Never merge** — the human merges; that's the approval. Same rule as `work-issue`.
5. Ask whether to keep going on the same branch or start a fresh session.

After the human merges: `git switch main && git pull && git branch -d <branch>`.

## Escalation

A task belongs in `work-issue`, not here, if it: spans multiple packages, changes infrastructure or auth behavior, needs a plan or a design decision, or the sub-agent comes back saying it's bigger than described. When that happens, say so, `capture` it as an issue if it's worth remembering, and move on to the next small task. Don't let one task swallow the session.

## Guardrails

- One branch, one PR, one task in flight.
- You orchestrate; sub-agents edit. Exception: trivial mechanical fixups to a sub-agent's commit message or a bad `git` state.
- Keep each commit scoped to its task, so a single bad one can be reverted without unpicking the batch.
- Unrelated problems discovered mid-task → note them for the user or `capture` an issue; never widen the diff.
- If `just ci` won't go green after a couple of honest attempts, stop and ask rather than guessing.

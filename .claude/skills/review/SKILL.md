---
name: review
description: Review the session diff with a sub-agent that knows isthmia's conventions — auth model, secrets, Pulumi patterns, ESM imports, test boundaries, and prose style. Use before opening a PR, or when the user asks for a review of the current branch.
---

# Review the Diff

Dispatch a sub-agent to review everything on the session branch. It reports findings. It does not fix them without being asked.

## 1. Collect the diff

```sh
git fetch origin main
git diff origin/main...HEAD --stat
git log origin/main..HEAD --oneline
```

If the diff is empty, say so and stop.

## 2. Dispatch the reviewer

Use `Agent` with `subagent_type: reviewer`.

The checklist lives in `.claude/agents/reviewer.md` — correctness, secrets and auth, infrastructure, TypeScript, prose, and scope. Do not repeat it in the prompt. Tell the agent only:

- The branch point to diff against, normally `origin/main...HEAD`.
- Anything in the batch that deserves extra attention, such as a change to auth or IAM.
- Anything already known and deliberate, so it does not report it as a finding.

The agent is read-only by construction. It has no `Edit` or `Write` tool, so it cannot fix what it finds.

## 3. Skip it when it cannot help

A review costs time. Skip it and say why when the whole diff is prose — markdown, comments, docs — because every item on the checklist is about code. Read the diff yourself instead.

Never skip a review when the diff touches auth, IAM, secrets, or `packages/infrastructure`.

## 4. Report

Give the user the findings grouped by severity. For each one, say whether you recommend fixing it now or capturing it as an issue.

Ask before fixing anything. The user decides. To fix, dispatch through `implement` so the fix gets its own commit.

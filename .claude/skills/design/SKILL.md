---
name: design
description: Write a design doc to .claude/plans/ for a task that needs a decision, then get the user to approve it before any code is written. Use for work that spans packages, changes infrastructure or auth, or has more than one reasonable approach.
---

# Design a Change

Produce a short design doc, get it approved, and hand it to `implement`. No code is written until the user approves the doc.

Use this only for tier-3 work. Most tasks do not need a design doc. If the approach is obvious, skip straight to `implement`.

## 1. Dispatch the designer

Use `Agent` with `subagent_type: designer`.

The agent knows the doc template, the investigation questions, and the repo pitfalls — they are in `.claude/agents/designer.md`. The prompt carries only:

- The problem, in the user's own words where possible.
- Any constraint or preference the user has already stated.
- Anything already ruled out, and why.

The agent writes the doc to `.claude/plans/` and reports its path, a summary, and its open questions. It cannot edit source files.

Stay available while it works. This is the longest sub-agent dispatch in the workflow.

## 2. Read it yourself

Read the doc before you show it to the user. You are accountable for what you put in front of them.

Check that it cites real code, that the steps are genuinely separable, and that the open questions are real decisions rather than research the agent skipped. Send it back if not.

## 3. Get approval

Show the user the doc path and a three-line summary. Ask directly for approval.

Answer their questions and edit the doc until they approve it. Do not start implementing while questions are open.

The user approves in conversation. There is no label and no PR gate for this.

## 4. Hand off

Once approved:

1. Commit the design doc on the session branch.
2. Run `implement` once per step in the Steps list.
3. If a step reveals the design was wrong, stop. Update the doc, tell the user what changed, and get agreement before continuing.

## Should this be a GitHub issue?

File one with `capture` only if the work will outlive this session. A design doc plus a same-session PR needs no issue.

If you do file one, link the design doc path from the issue body.

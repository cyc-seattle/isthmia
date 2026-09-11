---
name: design
description: Write a design doc to .claude/plans/ for a task that needs a decision, then get the user to approve it before any code is written. Use for work that spans packages, changes infrastructure or auth, or has more than one reasonable approach.
---

# Design a Change

Produce a short design doc, get it approved, and hand it to `implement`. No code is written until the user approves the doc.

Use this only for tier-3 work. Most tasks do not need a design doc. If the approach is obvious, skip straight to `implement`.

## 1. Investigate

Read the code before you propose anything. Dispatch an `Explore` sub-agent if the search is broad — it is read-only, so it does not block the session.

Find the answer to three questions:

- Where does this behavior live today?
- What already exists that can be reused?
- What breaks if this changes?

## 2. Write the doc

Write to `.claude/plans/<short-slug>.md`. Name it for the change, such as `roster-generator.md`.

Follow the `technical-writing` skill. Keep it short. A design doc that nobody reads has failed.

```markdown
# <Title>

## Context

What is wrong or wanted today, and why it matters. Reference real code as `path:line`.

## Approach

The proposed change. Name the packages and files it touches.

## Alternatives

Each option you rejected and the reason. One or two lines each. Omit this section if there
was only ever one sensible approach.

## Open questions

Anything the user must decide. Omit if there are none.

## Steps

An ordered list of implementation steps. Each step should be one `implement` dispatch and
one commit.
```

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

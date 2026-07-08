---
name: capture
description: Capture a new GitHub issue for the isthmia repo with the correct type label, priority, and a clear Problem/Fix body. Use when the user wants to file an issue, log a bug, or record a TODO ("capture this", "file an issue", "make an issue for X").
---

# Capture an Issue

Turn a problem — from the current conversation or the user's description — into a well-formed GitHub issue in `cyc-seattle/isthmia`.

## Steps

1. **Gather the problem.** Pull details from the conversation or ask the user. A good issue needs: what's wrong or wanted, where in the code (`path:line`), and why it matters.
2. **Check for duplicates first.** `gh issue list --state open --limit 100 --json number,title,labels`. If it overlaps an existing issue, tell the user and offer to comment on / rescope that one instead of filing a new duplicate.
3. **Pick a type label:** `bug`, `enhancement`, `documentation`, or `docker`.
4. **Assign a priority label** using the rubric below.
5. **Write the body** using the template below. Reference concrete files as `path:line`.
6. **Create it:** `gh issue create --title "<imperative title>" --label "<type>,<priority>" --body "$(cat <<'EOF' ... EOF)"`
7. **Report** the issue number and URL back to the user.

## Priority rubric (P0–P3)

- **P0 — Critical:** data integrity/corruption, production broken, or a security-critical hole. Work starts immediately.
- **P1 — High:** a significant bug or friction the user hits regularly, with no safe workaround (e.g. auth/tooling breakage).
- **P2 — Medium:** a real improvement or a bug with a workaround (added tests, hardening, moderate bugs).
- **P3 — Low:** cleanup, docs, polish, low-risk nice-to-haves.

## Body template

Keep it tight. Use `## Problem` always; then `## Fix` (bugs) or `## Proposed changes` / `## Scope` (enhancements); add `## Impact` when the "why" isn't obvious.

```markdown
## Problem

<what's wrong/wanted, with `path:line` references and a code snippet if useful>

## Fix

<concrete change; mention adding a regression test for bugs>

## Impact

<why it matters — omit if self-evident>
```

## Conventions

- **Title:** short, imperative, no priority prefix (priority lives in the label). e.g. "safeCall retries non-retryable errors with a 60s delay".
- Labels already exist: `P0`–`P3`, `bug`, `enhancement`, `documentation`, `docker`. Don't invent new ones without asking.
- For bugs, always note that the fix should include a regression test — tests live in `packages/*/test/**/*.test.ts`.
- Cross-link related issues with `#N` and note dependencies ("land #47 first").

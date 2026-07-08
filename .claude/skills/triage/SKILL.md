---
name: triage
description: Triage open GitHub issues in the isthmia repo — ensure each has a type + priority label, find duplicates/overlaps, flag unclear issues, and recommend close/rescope. Use when the user asks to triage, review the issue backlog, or clean up issues.
---

# Triage Issues

Review the open issue backlog for `cyc-seattle/isthmia` and bring it to a consistent, actionable state.

## Steps

1. **Pull the backlog with labels:**
   ```sh
   gh issue list --state open --limit 100 --json number,title,labels,createdAt \
     --jq 'sort_by(.number) | .[] | "\(.number)\t[\(.labels|map(.name)|join(","))]\t\(.title)"'
   ```
   Read the body of anything unlabeled or ambiguous: `gh issue view <N> --json body --jq .body`.
2. **Check every issue for two labels:** a type (`bug`/`enhancement`/`documentation`/`docker`) and a priority (`P0`–`P3`). Add whatever's missing (`gh issue edit <N> --add-label "<labels>"`).
3. **Find duplicates and overlaps.** Compare titles/bodies. True duplicates → recommend closing the newer one as a duplicate (`gh issue close <N> --reason "not planned"` after moving any unique content). Partial overlaps → keep both but cross-link and clarify the boundary between them.
4. **Flag unclear or stale issues:** missing repro/context, a proposed solution that's now outdated, or scope that's drifted. Recommend a rescope (edit title/body) rather than silently leaving it.
5. **Assign priorities** per the rubric below for anything missing one.
6. **Summarize** as a table (number, priority, status/recommendation). Call out `wontfix`/close/duplicate candidates explicitly.

## Priority rubric (P0–P3)

- **P0 — Critical:** data integrity/corruption, production broken, security-critical.
- **P1 — High:** significant bug or regular friction, no safe workaround.
- **P2 — Medium:** real improvement or bug with a workaround.
- **P3 — Low:** cleanup, docs, polish.

## What to act on vs. recommend

- **Act directly** (cheap, reversible): adding/adjusting labels, assigning priorities.
- **Recommend, then confirm** (content decisions): closing as duplicate/wontfix, rewriting an issue's title/body/scope. Present the recommendation and let the user approve before editing bodies or closing.

## Notes

- No priority labels existed originally; `P0` (red) → `P3` (green) were created. Reuse them.
- Closed non-PR issues are rare in this repo (PR-based flow means most low numbers are PRs). Don't assume gaps are missing issues.

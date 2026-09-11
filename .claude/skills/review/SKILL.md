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

Use `Agent` with `subagent_type: general-purpose` and `model: sonnet`. Tell it to read `CLAUDE.md` first, then review `git diff origin/main...HEAD` against the checklist below.

Tell it to report findings ranked by severity, each with a `path:line`, one sentence on the defect, and a concrete failure case. Tell it to report nothing when it finds nothing. A reviewer that invents findings to look useful is worse than no reviewer.

## Checklist

### Correctness

- Does the change do what its commit message claims?
- Are the error paths handled, or only the happy path?
- Does a bug fix come with a regression test?
- Do tests mock the external SDK boundary — Parse, google-spreadsheet, googleapis — rather than calling live APIs?

### Secrets and auth

- No credentials, tokens, or key files in the diff.
- Clubspot credentials come from environment variables locally and Secret Manager in production. Never hardcoded.
- The two Google credential types stay separate. User credentials are for deploys. Application Default Credentials are for running tools.
- No new code path logs in as a Workspace super-admin account. Individuals impersonate service accounts.
- No long-lived service account keys. Impersonation is the pattern.

### Infrastructure

- Pulumi resources follow the class-based pattern: a subclass with secure defaults and explicit grant methods.
- New IAM grants are least-privilege and declared in `packages/infrastructure/src/config.ts`.
- No resource is created before something needs it.

### TypeScript

- Import paths carry the `.js` extension.
- Strict mode is respected. Flag any new `any`, `as` cast, or non-null assertion that hides a real type problem.
- The package's place in the dependency graph is respected. Check `CLAUDE.md` before accepting a new cross-package import.

### Prose

- Comments follow the comment policy in `CLAUDE.md`. They explain why, not what.
- Comments, commit messages, and docs follow the `technical-writing` skill.

### Scope

- Does the diff contain changes nobody asked for?
- Is each commit scoped to one task?

## 3. Report

Give the user the findings grouped by severity. For each one, say whether you recommend fixing it now or capturing it as an issue.

Ask before fixing anything. The user decides. To fix, dispatch through `implement` so the fix gets its own commit.

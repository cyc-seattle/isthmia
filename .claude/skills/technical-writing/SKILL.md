---
name: technical-writing
description: Write clear, plain technical prose using a simplified-English style adapted from ASD-STE100. Use when writing or editing any prose that ships in this repo — CLAUDE.md, READMEs, skill files, design docs, code comments, commit messages, and PR or issue bodies.
---

# Technical Writing

House style for prose in this repo. It adapts ASD-STE100 (Simplified Technical English), the aerospace standard for documentation that non-native readers and translation tools must parse correctly.

This is **not** the full standard. There is no approved-word dictionary here and no linter. Apply the rules below by judgement.

## Scope

Applies to prose that ships in the repo:

- `CLAUDE.md`, `README` files, and skill files
- Design docs in `.claude/plans/`
- Code comments — the [comment policy](../../../CLAUDE.md) governs _whether_ to write one, this skill governs how to word it
- Commit messages, PR bodies, and issue bodies

It does not apply to terminal conversation. Chat can be normal English.

## Rules

### Words

1. **One word, one meaning.** Pick one term for a thing and use it everywhere. Do not vary the wording for style. If the code says `worksheet`, write "worksheet" every time — never "sheet", "tab", or "page".
2. **Use the short, common word.** Write "use", not "utilize". Write "before", not "prior to". Write "start", not "initiate".
3. **Use verbs, not nouns made from verbs.** Write "run the report", not "perform report execution". Write "we decided", not "a decision was made".
4. **Avoid phrasal verbs when one verb exists.** Write "start the job", not "kick off the job". Write "delete the row", not "get rid of the row".
5. **Technical terms are exempt.** Domain nouns and verbs stay as they are: `Parse`, `Pulumi`, `worksheet`, `impersonate`, `treefmt`, `service account`.

### Sentences

6. **One instruction per sentence.** Split compound steps into separate sentences or list items.
7. **Keep sentences short.** Instructions: 20 words or fewer. Descriptions: 25 words or fewer.
8. **Use the active voice for instructions.** Write "Run `just ci`", not "`just ci` should be run". The passive voice is allowed in descriptive text when the actor does not matter.
9. **Use simple tenses.** Present, past, future, imperative, infinitive. Avoid the perfect tenses: write "the deploy failed", not "the deploy has failed".
10. **Do not drop words to save space.** Keep articles, subjects, and verbs. A shorter sentence that is ambiguous is worse than a longer one that is clear.
11. **Limit noun strings to three words.** Rewrite "report runner service account key rotation" as "key rotation for the report-runner service account".
12. **Do not use semicolons.** Write two sentences instead. Other punctuation is fine, em dashes included.

### Structure

13. **One topic per paragraph**, six sentences at most.
14. **Use a list for any sequence, set of conditions, or set of options.** Do not bury them in prose.
15. **Put the warning first.** Lead with the condition or the command, not with background. Write "Never push to `main`. It is protected." — not "Because the branch is protected, you should avoid pushing to `main`."
16. **Cut the reassurance.** Delete "note that", "it's worth knowing", "importantly", "in practice", and any sentence whose job is to make the reader feel good. State the fact and stop.
17. **A procedure is steps, not a story.** A section telling someone how to do something is a list of what to do. Not what went wrong when you did it.

## Editing an existing file

Fix the wording of lines you touch for another reason. Do not rewrite a whole document to this style as a standalone task unless the user asks. Much of the existing prose predates this skill.

## Example

Before:

> It should be noted that in the event that the CI pipeline has not been observed to pass, the making of a decision regarding whether or not to proceed with the creation of the pull request will need to be undertaken by the user.

After:

> If CI fails, ask the user whether to open the PR anyway.

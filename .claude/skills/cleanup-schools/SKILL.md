---
name: cleanup-schools
description: Clean up `people.school` in the CRM's Directus — find spelling variants of the same school, propose a fix at the source that stops new variants, and propose per-row corrections for the rest. Use when the user wants to clean up school data, fix the roster's school filter, or prepare roster data for families.
---

# Clean Up School Data

`people.school` is free text. It's a promoted field: each family's answer to a Clubspot
registration question is copied onto `people` (see "Promoted fields" in `docs/crm-schema.md`). The
portal roster groups and filters by it, after `normalizeSchool`
(`packages/portal/src/roster/model.ts`). That function folds case, punctuation, and spacing, and
nothing else. So "Roosevelt HS" and "Roosevelt High School" show up as two schools.

Look for the fix at the source first. Every free-text answer can create a new variant.

## 1. Read the data

Use the Directus MCP tools (`mcp__directus__*`). If they need auth, run their `authenticate` tool
first.

1. Read every `people` row with a non-null `school`: `id`, `first_name`, `last_name`, `school`.
   Also read whether each one has a registration in a camp that hasn't ended, since only those show
   on the roster today.
2. Read `promoted_fields` to see which Clubspot question labels feed `school`.
3. Group the values by `normalizeSchool`, then cluster the groups by hand:
   - abbreviations (HS, MS, Elem, Acad);
   - dropped words ("Roosevelt" and "Roosevelt High");
   - typos;
   - one school written two ways ("St." and "Saint").

   Flag values that aren't a school at all: a grade, "N/A", "none", "homeschool", or a city.

Keep personal data in the terminal. Never put names into a commit, an issue, or a doc. School names
on their own are fine.

## 2. Look for a fix at the source

New variants stop only when families can't type them. Check, in order:

- **Make the Clubspot question a dropdown.** This is Clubspot configuration, not code. Propose a
  list of canonical names built from the clusters, plus "Other" and "Homeschool". The sync copies
  whatever answer arrives, so nothing in this repo has to change.
- **The question labels.** If `promoted_fields` lists several labels for the same question, check
  whether one camp's form asks it differently ("School" or "School attending in fall"). Answers to
  a vaguer wording are more often noise.
- **Code.** A canonical-name map in the sync or the portal would be new machinery for staff to
  maintain. Suggest it only if a dropdown isn't possible, and ask before designing it.

Report what you found, with each cluster's size, and what you propose. Ask before changing any
code or config.

## 3. Propose corrections for the rest

For each cluster, propose one canonical name. Use the school's own official name, not the most
common spelling. Then list every row whose value differs from it. Rank by roster impact: rows with
an active registration come first. For a value that isn't a school, propose clearing it or ask
the user.

Show it as a table, with cluster, canonical name, and the values it replaces with their counts.
Get the user's yes on the batch, or on each cluster, before you write anything. Then update
`people.school` through the Directus MCP tools.

A Directus edit holds until the family gives a different answer in Clubspot. The sync writes
Clubspot's answer only when it changes from the stored one (`planSyncedField`,
`packages/clubspot-sync/src/synced-fields.ts`). So a correction holds through re-syncs. The same
family answering differently next season brings back whatever they typed, which is why the
dropdown matters.

## 4. Check the result

Read `people.school` again and confirm each cluster now holds one value. On the roster page,
choose a program and check that the school filter lists each school once.

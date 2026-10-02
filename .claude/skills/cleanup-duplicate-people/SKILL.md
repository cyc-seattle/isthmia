---
name: cleanup-duplicate-people
description: Work through open `duplicate_person` audit findings in the CRM's Directus — find the code change that would stop a class of them recurring, and propose an approve or dismiss for each one that remains. Use when the user wants to clean up duplicate people, review duplicate findings, or prepare roster data for families.
---

# Clean Up Duplicate People

`clubspot-sync` raises one `duplicate_person` finding for each group of `people` rows that share
a normalized first and last name (`findDuplicatePeople`, `packages/clubspot-sync/src/merge.ts`).
Read "Matching a new row to an existing person" and "Merging a duplicate" in
`docs/crm-schema.md` first. They hold the rules this skill applies.

Look for the code fix first. Each duplicate the matcher creates is one more finding someone must
review by hand.

## 1. Read the data

Use the Directus MCP tools (`mcp__directus__*`). If they need auth, run their `authenticate` tool
first.

1. Read every `audit_findings` row with `kind = duplicate_person` and `status = open`. `subject` is
   the proposed keeper. `detail` lists each member's id and date of birth
   (`parseDuplicatePersonFindingMemberIds`, `packages/clubspot-sync/src/audit.ts`).
2. For each member, read the `people` row (`first_name`, `last_name`, `date_of_birth`, `email`,
   `phone`, `directus_user_id`), plus:
   - `participant_links` with each participant's registration and camp — is this row a participant?
   - `contact_for` — is it someone's guardian or emergency contact, and whose?
   - `my_contacts` — who are its guardians?
3. Rank the groups so the ones that block the portal come first: groups with a member in a camp
   that hasn't ended.

Keep personal data in the terminal. Never put names, emails, or dates of birth into a commit, an
issue, or a doc.

## 2. Look for a code fix

Sort the groups by why they exist. A cause shared by many groups is a gap in the matcher
(`packages/clubspot-sync/src/person-sync.ts` and `people.ts`), not a data problem. Check for:

- **Same person, different roles.** For example, an adult participant who is also a guardian. Each
  role has its own matching rule, so one person can get a row for each role.
- **Same name and date of birth.** The participant rule should have matched these. Find why it
  didn't: a normalization gap (nicknames, hyphens, accents, a middle name in the first-name field),
  a date format, or rows created before a matcher fix.
- **Guardians one edit apart.** The guardian rule allows one character of difference on the first
  name. Two rows with a shared email and last name, but two characters apart on the first name, are
  outside it.
- **Recurring groups.** A person who keeps reappearing after an approved merge means the matcher
  creates them again on every new registration.

For each cause, report how many groups it explains, the line of code responsible, and the change
you propose, with the test that would prove it. Stay inside the matcher's design: an email alone
must never match, and a false merge is worse than a false split. Don't propose a new job, column,
or sync pass. Ask before writing any code. If the user agrees, the change goes through
`implement`.

Groups of genuinely different people are not a code problem: a parent and child with the same
name, or two unrelated kids. Dismissing them is the right outcome.

## 3. Propose a fix for each remaining group

Give each group one verdict, with one line of evidence:

- **Approve** — the same person. Every member has the same non-null date of birth, or there's
  equivalent evidence: the same guardians, the same email and phone, or one row that has only a
  `contact_for` link and none of its own. Check the proposed keeper too. A merge fails if two
  members both hold a `directus_user_id`.
- **Dismiss** — different people. The dates of birth differ, or one is the other's guardian.
- **Fix the data first** — the dates of birth differ only by a typo, for example a swapped day and
  month. Propose the corrected `date_of_birth`, then approve. If the typo came from the family's
  Clubspot profile, say so, so staff can fix it at the source too.
- **Ask** — you can't tell. Say what's missing.

Show the verdicts as a table, with group, verdict, and evidence. Get the user's yes on the batch,
or on each row, before you write anything. Then set each finding's `status` to `approved` or
`dismissed`, and apply any `date_of_birth` corrections, through the Directus MCP tools.

A group where every member has the same non-null date of birth is safe to approve without a
second look. `selectMatchingDuplicateFindings`
(`packages/clubspot-sync/src/approve-matching-duplicates.ts`) applies the same rule.

## 4. Run the merge

Approved findings merge on the next sync run. Don't wait for the hourly run. Start it now:

```sh
gcloud run jobs execute clubspot-sync-job --region us-west1
```

Then read the findings again. A merged group reads `resolved`. A group that went back to `open`
failed to merge, and the job's logs say why.

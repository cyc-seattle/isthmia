---
tags: [gsuite, google-groups]
---

## Google Groups: how nested groups behave

gsuite-sync nests class groups under program groups. Nesting does not work the way most people
expect, so read this before you change group structure, posting settings, or who sends
announcements.

### Membership

A member of a nested group counts as a member of every group above it. When `j-pod@` is a member
of `race-team@`, each `j-pod@` member is also a member of `race-team@`. They are not members of
sibling groups such as `k-pod@`.

### Posting and delivery

Google checks each nested group's **Who can post** against the **original sender**, not the
parent group. A post to the parent reaches a nested group only when the sender may post to that
nested group too.

With **Who can post** set to members on every group:

| Sender                                | Who receives a post to the parent                       |
| ------------------------------------- | ------------------------------------------------------- |
| A member of `j-pod@`                  | `j-pod@` and the parent's direct members. Not `k-pod@`. |
| A direct member of the parent         | The parent's direct members only.                       |
| A manager or owner of the parent only | The parent's direct members only.                       |

For the audit this causes, see #158.

### How we get announcements to every descendant

Each program has an allowed-senders group, for example `race-team-announcers@`. gsuite-sync
nests it as a member in the program group and in every group below it, with delivery set to **No
email**. The members of the senders group then count as members everywhere, pass each group's
posting check, and reach every descendant. The "No email" setting stops them from getting a copy
from each group.

Use one senders group per program, not one for the whole org, so a sender reaches only their own
program's families.

Members of the senders group can read the web archive of every group it is nested in.

### Rejected options

- **Widen Who can post on class groups.** `ANYONE_CAN_POST` lets in spam. `ALL_IN_DOMAIN_CAN_POST`
  blocks guardians outside the domain from posting to their own class group.
- **Add each sender to every group directly.** This works, but each sender then needs a
  membership in every group, and removing one means finding all of them.
- **Don't nest.** Put every member into each group directly. This works, but a parent group then
  holds a copy of every descendant's members.

### Drive and Calendar

- **Drive and Sites** resolve nesting fully. Access granted to a parent group reaches the members
  of every descendant, whatever the posting settings. The highest access level wins.
- **Calendar** invites a nested group's members only when the inviter has **View members**
  permission on that nested group.

### Checks for group membership

`hasMember` resolves nesting only inside the domain. `checkTransitiveMembership` needs Enterprise
or Cloud Identity Premium, and CSC has Business Standard. Don't depend on either to resolve
membership across domains.

### Sources

- [Add a group to another group](https://knowledge.workspace.google.com/admin/groups/add-a-group-to-another-group)
  (Google)
- [Groups within Groups](https://docs.google.com/document/d/1DfTbCOml3mv2CM4NoaKUyBr3tx8P8tHxPv6nhssYxYU/edit)
  (UC Berkeley bConnected; Option 3 is the model above)

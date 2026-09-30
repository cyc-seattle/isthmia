import type { PermissionAction } from "../directus/client";

// Plain data (no `@pulumi/*` import) describing the Community role's three policies (#166) - a
// family or other signed-in community member reading their own teammates. Both `./index.ts` (which
// turns each policy into a `DirectusPolicy` plus its `DirectusPermissionRule` rows) and the
// integration test (`packages/infrastructure/integration/community-rules.test.ts`, which applies
// this same data against a throwaway instance) import this module, so the test always checks the
// rules that ship. See docs/crm-schema.md's Community section and the design doc for the shape
// this codifies.

type Filter = Record<string, unknown>;

/** `$CURRENT_USER.email`, compared against `people.email`. Authentik's scope mapping lowercases the
 * `email` claim and clubspot-sync stores `people.email` normalized the same way (#166), so both
 * sides of every filter below line up with no separate login column. */
const ME: Filter = { email: { _eq: "$CURRENT_USER.email" } };

/** Every camp running today - a roster is empty between seasons, and there is no "next season"
 * rule. */
const ACTIVE_CAMP: Filter = { start_date: { _lte: "$NOW" }, end_date: { _gte: "$NOW" } };

/** A null date of birth fails `_lte`, so an unknown birthdate counts as a minor with no special
 * case. */
const ADULT: Filter = { date_of_birth: { _lte: "$NOW(-18 years)" } };

/** Applied directly to a `contacts` row: "this link is a guardian relationship whose contact_id is
 * the signed-in user" - reused below both through `my_contacts` (to reach the guarded `people` row)
 * and directly (the `family` policy's own `contacts` read, below). */
const MY_GUARDIAN_LINK: Filter = { _and: [{ relationship_type: { _eq: "guardian" } }, { contact_id: ME }] };

/** A `people` row whose `my_contacts` (reverse of `contacts.subject_id`) has a guardian row back to
 * the signed-in user - i.e. "the signed-in user is this person's guardian." */
const GUARDIAN_OF: Filter = { my_contacts: MY_GUARDIAN_LINK };

/** The people a signed-in user acts for: themselves, or a minor they're a guardian contact of. */
const ACTS_FOR: Filter = { _or: [ME, GUARDIAN_OF] };

/** The signed-in user's own row, or a minor's guardian - the same set as `ACTS_FOR` restricted to
 * an adult on the self branch. Distinct from `ACTS_FOR`: a minor who happens to share a login (a
 * family commonly shares one email) must not be able to edit their own `share_contact` merely by
 * matching `$ME` - only a guardian, or an adult acting for themselves, can. */
const FAMILY_SELF: Filter = { _or: [GUARDIAN_OF, { _and: [ME, ADULT] }] };

/** A `registration_entries` row for a confirmed, active-camp class whose program has another
 * confirmed, active-camp entry belonging to someone the signed-in user acts for - the entries a
 * teammate page is built from. Applied to `registration_entries` directly (the `names` policy's own
 * rule) and reused, nested, everywhere else that needs "this row belongs to a teammate." */
const TEAM_ENTRY: Filter = {
  _and: [
    { status: { _eq: "confirmed" } },
    { class_id: { camp_id: ACTIVE_CAMP } },
    {
      class_id: {
        program_id: {
          classes: {
            _and: [
              { camp_id: ACTIVE_CAMP },
              {
                registration_entries: {
                  _and: [
                    { status: { _eq: "confirmed" } },
                    { registration_id: { participant_id: { person_id: ACTS_FOR } } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ],
};

/** A `people` row reachable through its own participant/registration/entries chain to a
 * `TEAM_ENTRY` - the set the `names` policy can see. */
const TEAMMATE: Filter = { participant_links: { registrations: { registration_entries: TEAM_ENTRY } } };

/** A teammate who has opted their contact info in - the subject side of a guardian link the
 * `contacts` policy exposes, whether that's the `people` row it substitutes in (guardian's row for
 * the minor's) or the link row itself (below). */
const OPTED_IN_TEAMMATE_SUBJECT: Filter = { _and: [TEAMMATE, { share_contact: { _eq: true } }] };

/** A `contacts` row for a guardian link whose subject has opted in - applied directly to `contacts`
 * (the `contacts` policy's own read, below) and reused through `contact_for` to reach the
 * guardian's `people` row instead. */
const SHARED_GUARDIAN_LINK: Filter = {
  _and: [{ relationship_type: { _eq: "guardian" } }, { subject_id: OPTED_IN_TEAMMATE_SUBJECT }],
};

export interface CommunityRuleFields {
  collection: string;
  action: PermissionAction;
  /** Omit for unrestricted access to the allowed fields (used only for the public camp/class/
   * program lookups below, none of which carry anything sensitive). */
  permissions?: Filter;
  fields: string[];
}

export interface CommunityPolicyData {
  /** Used to derive this policy's Pulumi resource names and the integration test's fixtures -
   * matches the design doc's policy names (`names`/`contacts`/`family`). */
  key: "names" | "contacts" | "family";
  name: string;
  icon: string;
  description: string;
  rules: CommunityRuleFields[];
}

export const communityPolicies: CommunityPolicyData[] = [
  {
    key: "names",
    name: "Community: names",
    icon: "groups",
    description:
      "Read-only: a teammate's name and school, plus the id-only joins the roster page uses to place " +
      "them on a team (#166). See docs/crm-schema.md.",
    rules: [
      {
        collection: "people",
        action: "read",
        fields: ["id", "first_name", "last_name", "school"],
        permissions: TEAMMATE,
      },
      {
        collection: "registration_entries",
        action: "read",
        fields: ["id", "status", "class_id", "registration_id"],
        permissions: TEAM_ENTRY,
      },
      {
        collection: "registrations",
        action: "read",
        fields: ["id", "participant_id"],
        permissions: { registration_entries: TEAM_ENTRY },
      },
      {
        collection: "participants",
        action: "read",
        fields: ["id", "person_id"],
        permissions: { registrations: { registration_entries: TEAM_ENTRY } },
      },
      // No filter: a class/program/camp's own name and dates aren't sensitive, and the roster page
      // needs every program's own to group by, not only ones the viewer already has a teammate in.
      { collection: "classes", action: "read", fields: ["id", "name", "camp_id", "program_id"] },
      { collection: "programs", action: "read", fields: ["id", "name"] },
      { collection: "camps", action: "read", fields: ["id", "name", "start_date", "end_date"] },
    ],
  },
  {
    key: "contacts",
    name: "Community: contacts",
    icon: "contact_mail",
    description:
      "Read-only: a teammate's email/phone once they've opted in (share_contact), or their opted-in " +
      "guardian's own email/phone in their place - plus the guardian-link rows that tell the page which " +
      "child each guardian belongs to. The board-approval gate (#166) - stays detached from the " +
      "Community role until communityContactsEnabled. See docs/crm-schema.md.",
    rules: [
      {
        collection: "people",
        action: "read",
        fields: ["id", "first_name", "last_name", "email", "phone"],
        permissions: {
          _or: [
            // A minor's own email/phone are never returned here - this branch returns the
            // *guardian's* row in their place, once the minor (the guardian's `subject_id`) has
            // opted in.
            { contact_for: SHARED_GUARDIAN_LINK },
            // An adult teammate's own opted-in row.
            { _and: [TEAMMATE, ADULT, { share_contact: { _eq: true } }] },
          ],
        },
      },
      // Links a shared guardian's `people` row (above) back to the child it belongs to - the page
      // can't otherwise tell which of several teammates' guardians a contacts row displays for.
      {
        collection: "contacts",
        action: "read",
        fields: ["subject_id", "contact_id", "relationship_type"],
        permissions: SHARED_GUARDIAN_LINK,
      },
    ],
  },
  {
    key: "family",
    name: "Community: family",
    icon: "family_restroom",
    description:
      "A family's own share_contact opt-in (#166): a guardian toggles it for a minor they guard, and an " +
      "adult participant toggles their own. Also the guardian-link rows the page uses to find who it's " +
      "allowed to toggle, so it never derives a write target from a read the `names` or `contacts` " +
      "policy happened to also grant. See docs/crm-schema.md.",
    rules: [
      {
        collection: "people",
        action: "read",
        fields: ["id", "first_name", "last_name", "share_contact"],
        permissions: FAMILY_SELF,
      },
      { collection: "people", action: "update", fields: ["share_contact"], permissions: FAMILY_SELF },
      // The signed-in user's own outgoing guardian links, fetched with this same filter written
      // explicitly into the request - never inferred from another policy's read - so the toggle's
      // write targets are exactly the viewer's own wards, plus themselves when they match FAMILY_SELF's
      // adult-self branch.
      {
        collection: "contacts",
        action: "read",
        fields: ["subject_id", "contact_id", "relationship_type"],
        permissions: MY_GUARDIAN_LINK,
      },
    ],
  },
];

import type { PermissionRuleInput } from "../directus/client";

// Plain data (no `@pulumi/*` import), so a test can check each filter against the schema.

/** Applied to a `contacts` row: a guardian link whose contact is the signed-in Directus user. */
const MY_GUARDIAN_LINK = {
  _and: [{ relationship_type: { _eq: "guardian" } }, { contact_id: { directus_user_id: { _eq: "$CURRENT_USER" } } }],
};

/** "The signed-in user is a guardian of the person at the end of `path`", through the `my_contacts`
 * alias on `people` (the reverse of `contacts.subject_id`). Directus doesn't accept a dotted key in a
 * filter: it drops the clause and fails the query with a 500, so each step nests. */
function guardianFilter(...path: string[]): Record<string, unknown> {
  return [...path, "my_contacts"].reduceRight<Record<string, unknown>>(
    (inner, field) => ({ [field]: inner }),
    MY_GUARDIAN_LINK,
  );
}

export const guardianRules: PermissionRuleInput[] = [
  { collection: "people", action: "read", permissions: guardianFilter() },
  { collection: "medical_profiles", action: "read", permissions: guardianFilter("person_id") },
  { collection: "registrations", action: "read", permissions: guardianFilter("participant_id", "person_id") },
  {
    collection: "registration_entries",
    action: "read",
    permissions: guardianFilter("registration_id", "participant_id", "person_id"),
  },
  { collection: "participants", action: "read", permissions: guardianFilter("person_id") },
];

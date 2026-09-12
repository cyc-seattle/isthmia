import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import {
  DirectusSchema,
  DirectusPermissionRule,
  DirectusPermissionRuleFields,
  collectionsInSchema,
} from "../directus/index.js";
import { auth, directusDatabase } from "./directus";
import { staffRole, coachRole, guardianRole } from "./directus-roles";
import { substrateApply } from "./substrate-apply";

// The people hub app's own Directus schema and permission rules, matching
// docs/people-hub-schema.md. The roles those rules attach to (and the one user) are identity, not
// app data, and live in directus-roles.ts instead - see the design doc's "Roles and users stay in
// infrastructure". A second Directus-backed app would define its own schema/rules in its own file,
// reusing the Directus* resources (../directus/) against the same instance and roles.

// The schema snapshot itself — collections/fields/relations, including the guardian_links alias
// field the Guardian role's filters below depend on. Applied via Directus's own REST API
// (schema/diff + schema/apply), not the CLI — see directus.ts's DirectusSchema for why that also
// sidesteps a schema-cache-staleness gotcha the CLI path has.
const schemaContent = readFileSync(resolve(__dirname, "../../../people-hub/schema.yaml"), "utf8");
const schema = yaml.load(schemaContent);

// Two edges, both required, and everything else here depends on this resource in turn:
// substrateApply (#107) is when the Directus container is guaranteed reconciled, and
// directusDatabase (#112) is when Directus owns its database - without that, `/schema/apply`
// returns 204 having created nothing.
export const peopleHubSchema = new DirectusSchema(
  "people-hub-schema",
  { ...auth, schema },
  { dependsOn: [substrateApply, directusDatabase] },
);

// Derived from schema.yaml itself (see #109) rather than hand-maintained, so it can't drift from
// what the schema actually declares.
const allCollections = collectionsInSchema(schema);

// Full read/write across every collection - one DirectusPermissionRule per (collection, action)
// pair, rather than an input on the role itself, so a future project can add or drop a Staff rule
// without an update that clobbers every other one (see the design doc's "Permission rules become
// their own resource").
for (const collection of allCollections) {
  for (const action of ["create", "read", "update", "delete"] as const) {
    new DirectusPermissionRule(
      `people-hub-staff-${collection}-${action}`,
      { ...auth, policyId: staffRole.policyId, collection, action },
      { dependsOn: [peopleHubSchema, staffRole] },
    );
  }
}

for (const collection of ["sessions", "registration_entries", "people", "programs", "classes"]) {
  new DirectusPermissionRule(
    `people-hub-coach-${collection}-read`,
    { ...auth, policyId: coachRole.policyId, collection, action: "read" },
    { dependsOn: [peopleHubSchema, coachRole] },
  );
}

// Filters through the `guardian_links` alias field on `people` (baked into
// packages/people-hub/schema.yaml — reverses contacts.related_person_id) to express "am I
// (the signed-in Directus user) a guardian of this person".
function guardianFilter(pathToGuardianLinks: string): Record<string, unknown> {
  return {
    [pathToGuardianLinks]: {
      _and: [{ relationship_type: { _eq: "guardian" } }, { person_id: { directus_user_id: { _eq: "$CURRENT_USER" } } }],
    },
  };
}

const guardianRules: DirectusPermissionRuleFields[] = [
  { collection: "people", action: "read", permissions: guardianFilter("guardian_links") },
  { collection: "medical_profiles", action: "read", permissions: guardianFilter("person_id.guardian_links") },
  { collection: "registrations", action: "read", permissions: guardianFilter("person_id.guardian_links") },
  {
    collection: "registration_entries",
    action: "read",
    permissions: guardianFilter("registration_id.person_id.guardian_links"),
  },
];
for (const rule of guardianRules) {
  new DirectusPermissionRule(
    `people-hub-guardian-${rule.collection}-${rule.action}`,
    { ...auth, policyId: guardianRole.policyId, ...rule },
    { dependsOn: [peopleHubSchema, guardianRole] },
  );
}

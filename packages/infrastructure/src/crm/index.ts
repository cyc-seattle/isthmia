import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as yaml from "js-yaml";
import { DirectusSchema, DirectusPermissionRule, DirectusPermissionRuleFields, collectionsInSchema } from "../directus";
import { directusBaseUrl, staffPolicyId, coachPolicyId, guardianPolicyId, clubspotSyncPolicyId } from "./refs";

// The CRM app's own Directus schema and permission rules, matching docs/crm-schema.md. The roles
// those rules attach to (and the one user) are identity, not app data, and stay in
// ../infrastructure. A second Directus-backed app would define its own schema/rules in its own
// project, reusing the Directus* resources (../directus/) against the same instance and roles.

// Same default as ../infrastructure/directus.ts's directusAdminEmail - kept as a separate read
// rather than a stack output, since this program authenticates to Directus's own API directly and
// the password (below) must never become a stack output.
const directusAdminEmail = new pulumi.Config().get("directusAdminEmail") ?? "master@cyccommunitysailing.org";

// The bootstrap admin's actual password, read the same way ../infrastructure/directus.ts reads it -
// by the secret's literal name, since a stack output would put the value in state twice. No
// dependsOn on the secret's creation: apply order (infrastructure first, per the justfile) is what
// guarantees it already exists.
const adminPassword = pulumi.secret(
  gcp.secretmanager
    .getSecretVersionOutput({ secret: "directus-admin-bootstrap-password" })
    .apply((version) => version.secretData),
);

const auth = { baseUrl: directusBaseUrl, adminEmail: directusAdminEmail, adminPassword };

// The schema snapshot itself — collections/fields/relations, including the my_contacts alias
// field the Guardian role's filters below depend on. Applied via Directus's own REST API
// (schema/diff + schema/apply), not the CLI — see directus.ts's DirectusSchema for why that also
// sidesteps a schema-cache-staleness gotcha the CLI path has.
const schemaContent = readFileSync(resolve(__dirname, "../../../crm/schema.yaml"), "utf8");
const schema = yaml.load(schemaContent);

// ../infrastructure's substrateApply (container reconciled) and directusDatabase (Directus owns
// its DB) edges don't cross a project boundary - apply order (infrastructure first, per the
// justfile) takes their place, with DirectusSchema's own waitForReachable retry as the safety net.
const crmSchema = new DirectusSchema("crm-schema", { ...auth, schema });

// Derived from schema.yaml itself (see #109) rather than hand-maintained, so it can't drift from
// what the schema actually declares.
const allCollections = collectionsInSchema(schema);

// Full read/write across every collection - one DirectusPermissionRule per (collection, action)
// pair, rather than an input on the role itself, so a future project can add or drop a Staff rule
// without an update that clobbers every other one.
for (const collection of allCollections) {
  for (const action of ["create", "read", "update", "delete"] as const) {
    new DirectusPermissionRule(
      `crm-staff-${collection}-${action}`,
      { ...auth, policyId: staffPolicyId, collection, action },
      { dependsOn: crmSchema },
    );
  }
}

for (const collection of ["sessions", "registration_entries", "people", "programs", "classes"]) {
  new DirectusPermissionRule(
    `crm-coach-${collection}-read`,
    { ...auth, policyId: coachPolicyId, collection, action: "read" },
    { dependsOn: crmSchema },
  );
}

// Filters through the `my_contacts` alias field on `people` (baked into
// packages/crm/schema.yaml — reverses contacts.related_person_id) to express "am I
// (the signed-in Directus user) a guardian of this person".
function guardianFilter(pathToMyContacts: string): Record<string, unknown> {
  return {
    [pathToMyContacts]: {
      _and: [{ relationship_type: { _eq: "guardian" } }, { person_id: { directus_user_id: { _eq: "$CURRENT_USER" } } }],
    },
  };
}

const guardianRules: DirectusPermissionRuleFields[] = [
  { collection: "people", action: "read", permissions: guardianFilter("my_contacts") },
  { collection: "medical_profiles", action: "read", permissions: guardianFilter("person_id.my_contacts") },
  { collection: "registrations", action: "read", permissions: guardianFilter("person_id.my_contacts") },
  {
    collection: "registration_entries",
    action: "read",
    permissions: guardianFilter("registration_id.person_id.my_contacts"),
  },
];
for (const rule of guardianRules) {
  new DirectusPermissionRule(
    `crm-guardian-${rule.collection}-${rule.action}`,
    { ...auth, policyId: guardianPolicyId, ...rule },
    { dependsOn: crmSchema },
  );
}

// Least privilege for the clubspot-sync machine user (crm-clubspot-sync in
// ../infrastructure/directus-roles.ts): create/read/update on every collection it writes.
const clubspotSyncCollections = [
  "programs",
  "sessions",
  "classes",
  "entry_caps",
  "people",
  "contacts",
  "medical_profiles",
  "registrations",
  "registration_entries",
  "registration_billing",
  "custom_field_definitions",
  "custom_field_responses",
  "sync_runs",
  "sync_program_runs",
];

for (const collection of clubspotSyncCollections) {
  for (const action of ["create", "read", "update"] as const) {
    new DirectusPermissionRule(
      `crm-clubspot-sync-${collection}-${action}`,
      { ...auth, policyId: clubspotSyncPolicyId, collection, action },
      { dependsOn: crmSchema },
    );
  }
}

// session_classes is a pure join with no status field, so a class a session no longer offers is
// deleted outright instead of cancelled - the one collection that needs the delete action.
for (const action of ["create", "read", "update", "delete"] as const) {
  new DirectusPermissionRule(
    `crm-clubspot-sync-session_classes-${action}`,
    { ...auth, policyId: clubspotSyncPolicyId, collection: "session_classes", action },
    { dependsOn: crmSchema },
  );
}

// promoted_fields is staff-maintained configuration, not synced data - the sync only reads it to
// know which custom-field labels feed which people column.
new DirectusPermissionRule(
  "crm-clubspot-sync-promoted_fields-read",
  { ...auth, policyId: clubspotSyncPolicyId, collection: "promoted_fields", action: "read" },
  { dependsOn: crmSchema },
);

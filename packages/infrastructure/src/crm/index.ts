import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as yaml from "js-yaml";
import {
  DirectusSchema,
  DirectusPermissionRule,
  DirectusPermissionRuleArgs,
  DirectusPermissionRuleFields,
  DirectusPolicy,
  collectionsInSchema,
  discoverSchemaFiles,
  mergeSchemas,
} from "../directus";
import * as random from "@pulumi/random";
import { crmIdentities } from "../directus/roles";
import { directusOnVm } from "./on-vm";
import { requireStringList } from "../config";
import { communityPolicies } from "./community-rules";
import { onCluster } from "../cluster";
import { deployDirectus } from "./cluster";

// The CRM app's Directus schema and permission rules, matching docs/crm-schema.md, and the roles and
// users they attach to (../directus/roles.ts). A second Directus-backed app would define its own
// schema/rules in its own project, reusing the Directus* resources (../directus/).

const config = new pulumi.Config();

// The same account as `infrastructure:directusAdminEmail`, which the VM's Directus creates.
const directusAdminEmail = config.require("directusAdminEmail");

// On the cluster, this project runs Directus. Off it, Directus is the VM's (./on-vm.ts).
// Directus's unlicensed Core tier refuses every permission row ("custom_permission_rules_enabled is a
// restricted resource") and any user whose provider isn't `default`, so without a license this
// project declares neither. Its roles, policies, sync users, and schema all still apply.
const licensed = config.getBoolean("licensed") ?? true;
function permissionRule(
  name: string,
  args: DirectusPermissionRuleArgs,
  opts?: pulumi.CustomResourceOptions,
): DirectusPermissionRule | undefined {
  return licensed ? new DirectusPermissionRule(name, args, opts) : undefined;
}

const app = onCluster() ? deployDirectus(directusAdminEmail, licensed) : undefined;

function offCluster() {
  const { auth, roles } = directusOnVm(
    directusAdminEmail,
    requireStringList("directusAdmins"),
    config.require("externalDomain"),
  );
  return {
    auth,
    staffPolicyId: roles.staffRole.policyId,
    coachPolicyId: roles.coachRole.policyId,
    guardianPolicyId: roles.guardianRole.policyId,
    clubspotSyncPolicyId: roles.clubspotSyncRole.policyId,
    gsuiteSyncPolicyId: roles.gsuiteSyncRole.policyId,
    communityRoleId: roles.communityRole.roleId,
  };
}

function onClusterIdentities(directus: NonNullable<typeof app>) {
  const auth = {
    baseUrl: directus.then(({ baseUrl }) => baseUrl),
    adminEmail: directusAdminEmail,
    adminPassword: pulumi.secret(directus.then(({ adminPassword }) => adminPassword)),
  };
  const token = (name: string) => pulumi.secret(new random.RandomPassword(name, { length: 64, special: false }).result);
  const clubspotSyncToken = token("clubspot-sync-directus-token");
  const gsuiteSyncToken = token("gsuite-sync-directus-token");
  const roles = crmIdentities({
    auth,
    readyForApiCalls: [directus.then(({ ready }) => ready)],
    // Whoever signs in through this environment's Authentik with one of these emails gets admin.
    // Core has no SSO, and refuses a user whose provider isn't `default`, so unlicensed there are none.
    admins: licensed ? (config.getObject<string[]>("directusAdmins") ?? []) : [],
    externalDomain: config.require("externalDomain"),
    clubspotSyncToken,
    gsuiteSyncToken,
    communityRoleId: pulumi.output(directus.then(({ communityRoleId }) => communityRoleId)),
  });
  return {
    auth,
    clubspotSyncToken,
    gsuiteSyncToken,
    staffPolicyId: roles.staffRole.policyId,
    coachPolicyId: roles.coachRole.policyId,
    guardianPolicyId: roles.guardianRole.policyId,
    clubspotSyncPolicyId: roles.clubspotSyncRole.policyId,
    gsuiteSyncPolicyId: roles.gsuiteSyncRole.policyId,
    communityRoleId: roles.communityRole.roleId,
  };
}

const identities = app ? onClusterIdentities(app) : offCluster();
const {
  auth,
  staffPolicyId,
  coachPolicyId,
  guardianPolicyId,
  clubspotSyncPolicyId,
  gsuiteSyncPolicyId,
  communityRoleId,
} = identities;

// The syncs read their Directus tokens through StackReferences. Only the on-cluster stack exports them.
export const clubspotSyncToken = "clubspotSyncToken" in identities ? identities.clubspotSyncToken : undefined;
export const gsuiteSyncToken = "gsuiteSyncToken" in identities ? identities.gsuiteSyncToken : undefined;

// Every package's own schema.yaml, merged into one snapshot and applied through a single
// DirectusSchema resource below — not applied per package, since a canonical package's apply would
// otherwise drop a field a provider package owns and hasn't re-applied yet. The file list itself
// comes from disk (see discoverSchemaFiles), not a hand-maintained array here, so a new package's
// schema.yaml is picked up automatically. Applied via Directus's own REST API (schema/diff +
// schema/apply), not the CLI — see directus.ts's DirectusSchema for why that also sidesteps a
// schema-cache-staleness gotcha the CLI path has.
const schemaFiles = discoverSchemaFiles(resolve(__dirname, "../../../"));
const loadedSchemas = schemaFiles.map(({ name, path }) => ({
  name,
  schema: yaml.load(readFileSync(path, "utf8")),
}));
const schema = mergeSchemas(loadedSchemas);

// Off the cluster, apply order (infrastructure first, per scripts/each-stack) stands in for a
// dependency on the VM's Directus, with DirectusSchema's own waitForReachable retry as the safety net.
const crmSchema = new DirectusSchema(
  "crm-schema",
  { ...auth, schema },
  app ? { dependsOn: [app.then(({ ready }) => ready)] } : undefined,
);

// Derived from schema.yaml itself (see #109) rather than hand-maintained, so it can't drift from
// what the schema actually declares.
const allCollections = collectionsInSchema(schema);

// Every table-backed collection packages/clubspot/schema.yaml declares - Clubspot is the editor of
// that data, so Staff gets read there, not write. Derived the same way as allCollections, from the
// clubspot package's own schema rather than the merged one, since the merged snapshot no longer
// says which package owns a collection.
const clubspotSchema = loadedSchemas.find(({ name }) => name === "clubspot")?.schema;
if (clubspotSchema === undefined) {
  throw new Error("crm/index.ts: expected a packages/clubspot/schema.yaml to derive Staff's read-only collections");
}
const clubspotOwnedCollections = collectionsInSchema(clubspotSchema);

/**
 * Staff's permission rules: full CRUD on every collection, except each one Clubspot owns, since
 * editing happens in Clubspot, not here. Two exceptions to that carve-out: `promoted_fields` is
 * staff-authored config despite living in the clubspot package, so it keeps full CRUD; and
 * `classes.program_id` and `participants.person_id` are the fields Staff sets by hand - a
 * class's program and a participant's match to a curated person - so each gets a field-scoped
 * update rule alongside its read.
 */
export function staffPermissionRules(
  allCollections: string[],
  clubspotOwnedCollections: string[],
): DirectusPermissionRuleFields[] {
  const clubspotReadOnly = new Set(clubspotOwnedCollections.filter((collection) => collection !== "promoted_fields"));

  const rules: DirectusPermissionRuleFields[] = [];
  for (const collection of allCollections) {
    if (clubspotReadOnly.has(collection)) {
      rules.push({ collection, action: "read" });
    } else {
      for (const action of ["create", "read", "update", "delete"] as const) {
        rules.push({ collection, action });
      }
    }
  }

  rules.push({ collection: "classes", action: "update", fields: ["program_id"] });
  rules.push({ collection: "participants", action: "update", fields: ["person_id"] });

  return rules;
}

for (const rule of staffPermissionRules(allCollections, clubspotOwnedCollections)) {
  const suffix = rule.fields ? `${rule.action}-${rule.fields.join("-")}` : rule.action;
  permissionRule(
    `crm-staff-${rule.collection}-${suffix}`,
    { ...auth, policyId: staffPolicyId, ...rule },
    { dependsOn: crmSchema },
  );
}

for (const collection of ["sessions", "registration_entries", "people", "programs", "camps", "classes"]) {
  permissionRule(
    `crm-coach-${collection}-read`,
    { ...auth, policyId: coachPolicyId, collection, action: "read" },
    { dependsOn: crmSchema },
  );
}

// Filters through the `my_contacts` alias field on `people` (baked into
// packages/crm/schema.yaml — reverses contacts.subject_id) to express "am I
// (the signed-in Directus user) a guardian of this person".
function guardianFilter(pathToMyContacts: string): Record<string, unknown> {
  return {
    [pathToMyContacts]: {
      _and: [
        { relationship_type: { _eq: "guardian" } },
        { contact_id: { directus_user_id: { _eq: "$CURRENT_USER" } } },
      ],
    },
  };
}

const guardianRules: DirectusPermissionRuleFields[] = [
  { collection: "people", action: "read", permissions: guardianFilter("my_contacts") },
  { collection: "medical_profiles", action: "read", permissions: guardianFilter("person_id.my_contacts") },
  { collection: "registrations", action: "read", permissions: guardianFilter("participant_id.person_id.my_contacts") },
  {
    collection: "registration_entries",
    action: "read",
    permissions: guardianFilter("registration_id.participant_id.person_id.my_contacts"),
  },
  { collection: "participants", action: "read", permissions: guardianFilter("person_id.my_contacts") },
];
for (const rule of guardianRules) {
  permissionRule(
    `crm-guardian-${rule.collection}-${rule.action}`,
    { ...auth, policyId: guardianPolicyId, ...rule },
    { dependsOn: crmSchema },
  );
}

// Least privilege for the clubspot-sync machine user (crm-clubspot-sync in
// ../directus/roles.ts): create/read/update on every collection it writes.
// `programs` is deliberately absent: a program is durable and staff-created, and Clubspot has no
// durable program id to derive one from. Withholding the grant makes that a rule the permission
// system enforces, not just one the mapping code happens to follow.
const clubspotSyncCollections = [
  "camps",
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
  "participants",
  "contact_points",
  "sync_tasks",
  "sync_runs",
  "audit_findings",
];

for (const collection of clubspotSyncCollections) {
  for (const action of ["create", "read", "update"] as const) {
    permissionRule(
      `crm-clubspot-sync-${collection}-${action}`,
      { ...auth, policyId: clubspotSyncPolicyId, collection, action },
      { dependsOn: crmSchema },
    );
  }
}

// session_classes is a pure join with no status field, so a class a session no longer offers is
// deleted outright instead of cancelled - the one collection that needs the delete action.
for (const action of ["create", "read", "update", "delete"] as const) {
  permissionRule(
    `crm-clubspot-sync-session_classes-${action}`,
    { ...auth, policyId: clubspotSyncPolicyId, collection: "session_classes", action },
    { dependsOn: crmSchema },
  );
}

// registration_billing keys on the billing objectId, so a replaced billing object is a delete of
// the old row followed by a create, not an update - see planRegistrationBilling.
permissionRule(
  "crm-clubspot-sync-registration_billing-delete",
  { ...auth, policyId: clubspotSyncPolicyId, collection: "registration_billing", action: "delete" },
  { dependsOn: crmSchema },
);

// promoted_fields is staff-maintained configuration, not synced data - the sync only reads it to
// know which custom-field labels feed which people column.
permissionRule(
  "crm-clubspot-sync-promoted_fields-read",
  { ...auth, policyId: clubspotSyncPolicyId, collection: "promoted_fields", action: "read" },
  { dependsOn: crmSchema },
);

// program_role_assignments and event_staff are owned elsewhere - the merge executor only repoints
// person_id off a duplicate onto its keeper, never creates or reads beyond that (#133).
for (const collection of ["program_role_assignments", "event_staff"]) {
  for (const action of ["read", "update"] as const) {
    permissionRule(
      `crm-clubspot-sync-${collection}-${action}`,
      { ...auth, policyId: clubspotSyncPolicyId, collection, action },
      { dependsOn: crmSchema },
    );
  }
}

// A person merge folds a duplicate's own rows onto its keeper, then deletes the duplicate - the
// only deletes clubspot-sync's policy grants (#133).
for (const collection of ["people", "contacts", "contact_points", "medical_profiles"]) {
  permissionRule(
    `crm-clubspot-sync-${collection}-delete`,
    { ...auth, policyId: clubspotSyncPolicyId, collection, action: "delete" },
    { dependsOn: crmSchema },
  );
}

// Least privilege for the gsuite-sync machine user (crm-gsuite-sync in
// ../directus/roles.ts): read on every collection it maps from into Google Groups.
const gsuiteSyncReadCollections = [
  "people",
  "contacts",
  "registrations",
  "registration_entries",
  "classes",
  "camps",
  "programs",
  "program_role_assignments",
];

for (const collection of gsuiteSyncReadCollections) {
  permissionRule(
    `crm-gsuite-sync-${collection}-read`,
    { ...auth, policyId: gsuiteSyncPolicyId, collection, action: "read" },
    { dependsOn: crmSchema },
  );
}

// participants holds guardian and medical answers gsuite-sync has no reason to see - only the
// link back to a person, to find its planned group membership.
permissionRule(
  "crm-gsuite-sync-participants-read",
  { ...auth, policyId: gsuiteSyncPolicyId, collection: "participants", action: "read", fields: ["id", "person_id"] },
  { dependsOn: crmSchema },
);

// contact_points holds every email and phone, not only the primary - gsuite-sync reads it to spot
// a live group member whose address is a person's known secondary, not an unexpected one.
permissionRule(
  "crm-gsuite-sync-contact_points-read",
  {
    ...auth,
    policyId: gsuiteSyncPolicyId,
    collection: "contact_points",
    action: "read",
    fields: ["id", "person_id", "kind", "normalized"],
  },
  { dependsOn: crmSchema },
);

// The only collections gsuite-sync writes: its own run queue and the audit findings it raises.
// `google_groups` is written by the discovery pass, which mirrors the group graph out of Workspace.
// No delete: a group that vanishes from Workspace leaves its row alone and raises a `missing_group`
// finding instead, so a class still pointing at it doesn't silently lose its target.
for (const collection of ["sync_tasks", "audit_findings", "google_groups"]) {
  for (const action of ["create", "read", "update"] as const) {
    permissionRule(
      `crm-gsuite-sync-${collection}-${action}`,
      { ...auth, policyId: gsuiteSyncPolicyId, collection, action },
      { dependsOn: crmSchema },
    );
  }
}

// The Community role's policies (../directus/roles.ts declares the role itself),
// built from the plain data in ./community-rules.ts so the integration test applies exactly what
// ships here.
for (const policyData of communityPolicies) {
  const policy = new DirectusPolicy(
    `crm-community-${policyData.key}`,
    {
      ...auth,
      roleId: communityRoleId,
      name: policyData.name,
      icon: policyData.icon,
      description: policyData.description,
    },
    { dependsOn: crmSchema },
  );

  for (const rule of policyData.rules) {
    permissionRule(
      `crm-community-${policyData.key}-${rule.collection}-${rule.action}`,
      { ...auth, policyId: policy.policyId, ...rule },
      { dependsOn: crmSchema },
    );
  }
}

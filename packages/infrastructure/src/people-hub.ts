import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { DirectusRole, DirectusPermissionRule } from "./directus";
import { internalDomain } from "./dns";

// The people hub app's own Directus roles/policies, matching the Permission model in
// docs/people-hub-schema.md. A second Directus-backed app would define its own roles in its own
// file, reusing DirectusRole (directus.ts) against the same instance.

const config = new pulumi.Config();
// Same default as substrate-bootstrap.ts's DIRECTUS_ADMIN_EMAIL — kept as a separate read (not a
// shared import) to avoid a cycle: compute.ts -> substrate-bootstrap.ts, and this file must not be
// part of that chain.
const directusAdminEmail = config.get("directusAdminEmail") ?? "master@cyccommunitysailing.org";

const baseUrl = pulumi.interpolate`https://crm.${internalDomain}`;

// The bootstrap admin's actual password — not just a reference to the secret container, the value
// itself — because these resources authenticate to the Directus API as that admin to create
// roles/policies. This is the one place in the program that reads a Secret Manager value rather
// than just declaring/granting the container; it never leaves the deployer's own `pulumi up`
// process, which already has legitimate access to it (they're the one who set it).
const adminPassword = gcp.secretmanager
  .getSecretVersionOutput({ secret: "directus-admin-bootstrap-password" })
  .apply((version) => version.secretData);

const allCollections = [
  "people",
  "medical_profiles",
  "contacts",
  "event_staff",
  "programs",
  "sessions",
  "classes",
  "session_classes",
  "entry_caps",
  "registrations",
  "registration_entries",
];

export const staffRole = new DirectusRole("people-hub-staff", {
  baseUrl,
  adminEmail: directusAdminEmail,
  adminPassword,
  name: "Staff",
  icon: "badge",
  description:
    "Full read/write on the people hub, including medical data. Workspace accounts only (native Google OIDC).",
  permissionRules: allCollections.flatMap((collection): DirectusPermissionRule[] =>
    (["create", "read", "update", "delete"] as const).map((action) => ({ collection, action })),
  ),
});

export const coachRole = new DirectusRole("people-hub-coach", {
  baseUrl,
  adminEmail: directusAdminEmail,
  adminPassword,
  name: "Coach",
  icon: "sports",
  description:
    "Read-only roster access (sessions/registration_entries/people). No medical_profiles. Not scoped to the " +
    "coach's own sessions yet - KISS for now, see docs/people-hub-schema.md.",
  permissionRules: ["sessions", "registration_entries", "people", "programs", "classes"].map(
    (collection): DirectusPermissionRule => ({ collection, action: "read" }),
  ),
});

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

export const guardianRole = new DirectusRole("people-hub-guardian", {
  baseUrl,
  adminEmail: directusAdminEmail,
  adminPassword,
  name: "Guardian",
  icon: "family_restroom",
  description:
    "Read own minors' people/medical_profiles/registrations/registration_entries. Filtered through contacts. " +
    "No login yet - needs #65's account-linking.",
  permissionRules: [
    { collection: "people", action: "read", permissions: guardianFilter("guardian_links") },
    {
      collection: "medical_profiles",
      action: "read",
      permissions: guardianFilter("person_id.guardian_links"),
    },
    {
      collection: "registrations",
      action: "read",
      permissions: guardianFilter("person_id.guardian_links"),
    },
    {
      collection: "registration_entries",
      action: "read",
      permissions: guardianFilter("registration_id.person_id.guardian_links"),
    },
  ],
});

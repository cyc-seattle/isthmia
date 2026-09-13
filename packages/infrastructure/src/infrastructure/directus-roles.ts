import { DirectusRole, DirectusUser } from "../directus/index.js";
import { auth, directusDatabase, clubspotSyncDirectusToken } from "./directus";
import { substrateApply } from "./substrate-apply";

// The identity layer for Directus-backed apps: roles/policies and the users assigned to them.
// Outlives any one app (see #65) and is deliberately kept out of ../crm/, which owns only
// the schema and the permission rules attached to these roles' policies.

// Same two edges crmSchema depends on (substrateApply for a reconciled Directus container,
// directusDatabase for Directus owning its DB) rather than a dependency on crmSchema itself:
// a role/policy is collection-agnostic, so it doesn't need the schema applied first. The
// collection-referencing permission rules that do need the schema declare that dependency
// themselves, in ../crm/.
const readyForApiCalls = [substrateApply, directusDatabase];

export const staffRole = new DirectusRole(
  "crm-staff",
  {
    ...auth,
    name: "Staff",
    icon: "badge",
    description: "Full read/write on the CRM, including medical data. Workspace accounts only (native Google OIDC).",
    appAccess: true,
  },
  { dependsOn: readyForApiCalls },
);

export const coachRole = new DirectusRole(
  "crm-coach",
  {
    ...auth,
    name: "Coach",
    icon: "sports",
    description:
      "Read-only roster access (sessions/registration_entries/people). No medical_profiles. Not scoped to the " +
      "coach's own sessions yet - KISS for now, see docs/crm-schema.md.",
    appAccess: true,
  },
  { dependsOn: readyForApiCalls },
);

export const guardianRole = new DirectusRole(
  "crm-guardian",
  {
    ...auth,
    name: "Guardian",
    icon: "family_restroom",
    description:
      "Read own minors' people/medical_profiles/registrations/registration_entries. Filtered through contacts. " +
      "No login yet - needs #65's account-linking.",
    // Guardians will eventually sign in through a future end-user-facing portal, not the Directus
    // Data Studio itself - API-only access.
    appAccess: false,
  },
  { dependsOn: readyForApiCalls },
);

// The first real Staff account: ungood, via Google OIDC — no password, no manual "sign in as the
// bootstrap admin and create my account" dance. Provisioning more staff this way (rather than
// through the Directus UI) is a reasonable next step once there's a list of who needs access; for
// now this is just the one account actually doing the deploying.
export const ungoodUser = new DirectusUser("crm-staff-ungood", {
  ...auth,
  email: "ungood@onetrue.name",
  roleId: staffRole.roleId,
  provider: "google",
  externalIdentifier: "ungood@onetrue.name",
});

// Least privilege for the clubspot-sync job: no Data Studio access, and (per its permission rules
// in ../crm/index.ts) write access to only the collections it syncs. The role is collection-agnostic
// identity and lives here; the rules need the schema applied first, so they live in ../crm/ - see
// the design doc's "Authentication to Directus".
export const clubspotSyncRole = new DirectusRole(
  "crm-clubspot-sync",
  {
    ...auth,
    name: "Clubspot Sync",
    icon: "sync",
    description: "Machine user for the clubspot-sync job. API-only, least privilege.",
    appAccess: false,
  },
  { dependsOn: readyForApiCalls },
);

// A machine user authenticated by a static token (`token`), not an interactive login - there is no
// human to sign in as, so `provider: "default"` and no `externalIdentifier`.
export const clubspotSyncUser = new DirectusUser("crm-clubspot-sync-user", {
  ...auth,
  email: "clubspot-sync@cyccommunitysailing.org",
  roleId: clubspotSyncRole.roleId,
  provider: "default",
  token: clubspotSyncDirectusToken.value,
});

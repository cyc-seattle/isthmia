import { DirectusRole, DirectusUser } from "../directus/index.js";
import { auth, directusDatabase } from "./directus";
import { substrateApply } from "./substrate-apply";

// The identity layer for Directus-backed apps: roles/policies and the users assigned to them.
// Outlives any one app (see #65) and is deliberately kept out of people-hub.ts, which owns only
// the schema and the permission rules attached to these roles' policies.

// Same two edges peopleHubSchema depends on (substrateApply for a reconciled Directus container,
// directusDatabase for Directus owning its DB) rather than a dependency on peopleHubSchema itself:
// a role/policy is collection-agnostic, so it doesn't need the schema applied first. The
// collection-referencing permission rules that do need the schema declare that dependency
// themselves, in people-hub.ts.
const readyForApiCalls = [substrateApply, directusDatabase];

export const staffRole = new DirectusRole(
  "people-hub-staff",
  {
    ...auth,
    name: "Staff",
    icon: "badge",
    description:
      "Full read/write on the people hub, including medical data. Workspace accounts only (native Google OIDC).",
    appAccess: true,
  },
  { dependsOn: readyForApiCalls },
);

export const coachRole = new DirectusRole(
  "people-hub-coach",
  {
    ...auth,
    name: "Coach",
    icon: "sports",
    description:
      "Read-only roster access (sessions/registration_entries/people). No medical_profiles. Not scoped to the " +
      "coach's own sessions yet - KISS for now, see docs/people-hub-schema.md.",
    appAccess: true,
  },
  { dependsOn: readyForApiCalls },
);

export const guardianRole = new DirectusRole(
  "people-hub-guardian",
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
export const ungoodUser = new DirectusUser("people-hub-staff-ungood", {
  ...auth,
  email: "ungood@onetrue.name",
  roleId: staffRole.roleId,
  provider: "google",
  externalIdentifier: "ungood@onetrue.name",
});

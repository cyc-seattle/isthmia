import * as pulumi from "@pulumi/pulumi";
import { DirectusAdminAccessGrant, DirectusRole, DirectusUser } from "./resources";

// The CRM's roles and the users assigned to them. `infrastructure` declares them in prod until its
// state moves to `crm` (#231), and `crm` declares them on the cluster, so both call this.

export interface CrmIdentityArgs {
  auth: { baseUrl: pulumi.Input<string>; adminEmail: pulumi.Input<string>; adminPassword: pulumi.Input<string> };
  /** What must exist before Directus answers: the roles and admin grants wait on it. */
  readyForApiCalls: pulumi.Input<pulumi.Resource>[];
  /** Staff accounts given admin access, signed in through Authentik. */
  admins: string[];
  /** The sync users' email domain. */
  externalDomain: string;
  clubspotSyncToken: pulumi.Input<string>;
  gsuiteSyncToken: pulumi.Input<string>;
  /** Fixes the Community role's ID, so Directus can name it as the default role before it exists. */
  communityRoleId?: pulumi.Input<string>;
}

export interface CrmIdentities {
  staffRole: DirectusRole;
  coachRole: DirectusRole;
  guardianRole: DirectusRole;
  communityRole: DirectusRole;
  clubspotSyncRole: DirectusRole;
  gsuiteSyncRole: DirectusRole;
  clubspotSyncUser: DirectusUser;
  gsuiteSyncUser: DirectusUser;
}

export function crmIdentities(args: CrmIdentityArgs): CrmIdentities {
  const { auth, readyForApiCalls } = args;

  const staffRole = new DirectusRole(
    "crm-staff",
    {
      ...auth,
      name: "Staff",
      icon: "badge",
      description:
        "Full read/write on the CRM, including medical data, except Clubspot collections are read-only " +
        "(classes.program_id and participants.person_id excepted). Workspace accounts only (native Google OIDC).",
      appAccess: true,
    },
    { dependsOn: readyForApiCalls },
  );

  const coachRole = new DirectusRole(
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

  const guardianRole = new DirectusRole(
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

  // Families and other signed-in community members (#166) - public registration through the
  // `authentik` OIDC provider (Directus's AUTH_AUTHENTIK_DEFAULT_ROLE_ID), with no login to the Data
  // Studio. Every grant comes from the three policies in ../crm/community-rules.ts, attached
  // separately (as DirectusPolicy, not this role's own bundled one) since a permission row is keyed
  // on (policy, collection, action).
  const communityRole = new DirectusRole(
    "crm-community",
    {
      ...auth,
      name: "Community",
      icon: "groups",
      description:
        "Families and other signed-in community members (#166), reading only their own teammates - see " +
        "../crm/community-rules.ts. Public registration, no Data Studio login.",
      appAccess: false,
      ...(args.communityRoleId !== undefined && { fixedRoleId: args.communityRoleId }),
    },
    { dependsOn: readyForApiCalls },
  );

  // Staff accounts with admin access, signed in through Authentik with no password.
  //
  // Via `authentik` (#166): a Directus username is a unique email, and a staff member who's also a
  // parent would collide with the Community account the `authentik` provider's public registration
  // creates for them. Directus has no second OIDC provider to fall back to - the built-in
  // ADMIN_EMAIL/ADMIN_PASSWORD account is the break-glass login if Authentik is down.
  //
  // Admin access is attached to each account, not to Staff, pending a better model for granting it
  // more broadly. The aliases keep the names these had when they were keyed on the email's local part.
  for (const email of args.admins) {
    const handle = email.replace(/@.*/, "");
    const user = new DirectusUser(
      `crm-staff-${email}`,
      { ...auth, email, roleId: staffRole.roleId, provider: "authentik", externalIdentifier: email },
      { aliases: [{ name: `crm-staff-${handle}` }] },
    );
    new DirectusAdminAccessGrant(
      `crm-staff-${email}-admin`,
      {
        ...auth,
        userId: user.userId,
        name: `${handle} (admin exception)`,
        icon: "shield_person",
        description: "Per-account admin exception; not modeled as a role.",
      },
      { dependsOn: readyForApiCalls, aliases: [{ name: `crm-staff-${handle}-admin` }] },
    );
  }

  // Least privilege for the clubspot-sync job: no Data Studio access, and (per its permission rules
  // in ../crm/index.ts) write access to only the collections it syncs. The role is collection-agnostic
  // identity; the rules need the schema applied first, so they live in ../crm/.
  const clubspotSyncRole = new DirectusRole(
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
  const clubspotSyncUser = new DirectusUser("crm-clubspot-sync-user", {
    ...auth,
    email: `clubspot-sync@${args.externalDomain}`,
    roleId: clubspotSyncRole.roleId,
    provider: "default",
    token: args.clubspotSyncToken,
  });

  // Same shape as clubspot-sync above, for the gsuite-sync job: no Data Studio access, and (per its
  // permission rules in ../crm/index.ts) read on what it maps from into Google Groups plus write on
  // sync_tasks/audit_findings only.
  const gsuiteSyncRole = new DirectusRole(
    "crm-gsuite-sync",
    {
      ...auth,
      name: "Gsuite Sync",
      icon: "sync",
      description: "Machine user for the gsuite-sync job. API-only, least privilege.",
      appAccess: false,
    },
    { dependsOn: readyForApiCalls },
  );

  const gsuiteSyncUser = new DirectusUser("crm-gsuite-sync-user", {
    ...auth,
    email: `gsuite-sync@${args.externalDomain}`,
    roleId: gsuiteSyncRole.roleId,
    provider: "default",
    token: args.gsuiteSyncToken,
  });

  return {
    staffRole,
    coachRole,
    guardianRole,
    communityRole,
    clubspotSyncRole,
    gsuiteSyncRole,
    clubspotSyncUser,
    gsuiteSyncUser,
  };
}

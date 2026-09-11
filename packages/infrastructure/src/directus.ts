import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as postgresql from "@pulumi/postgresql";
import { postgres, postgresProvider, postgresSuperuser } from "./database";
import { address, substrateRunner } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { Secret, randomSecret } from "./secret";
import { enableService } from "./services";
import { waitForReachable, login, directusRequest, applySchema } from "./directus-client";

// Directus itself: the substrate for the people hub (and any future app that wants a
// relationship-based permission engine — see docs/architecture.md). Runs on the substrate VM
// against its own database on the shared Cloud SQL instance. One database for the whole instance,
// not one per app — Directus's own collections are how data is organized within it.
//
// App-specific schema/roles/users (e.g. the people hub's) live in that app's own file — see
// people-hub.ts — built on the DirectusRole/DirectusUser/DirectusSchema resources this file
// exports.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

export const directusDatabase = postgres.database("directus");

// Directus's own secrets. The Google OAuth client is shared platform-wide (substrate.ts), not
// declared here — signing in once should sign into every surface on the substrate, not just this
// one.
//
// The internal ones (key/secret/db password/bootstrap password) have no meaningful human choice,
// so Pulumi generates and manages their values directly (randomSecret) — nothing to set out of
// band. `directus-license-key` stays a plain Secret: it's an external credential (the Open
// Innovation Grant / a paid license), same "container only, value out of band" pattern as
// `google-oauth-client-id`/`-secret` in substrate.ts.
const directusKey = randomSecret("directus-key", { dependsOn: secretmanagerApi });
const directusSecret = randomSecret("directus-secret", { dependsOn: secretmanagerApi });
const directusDbPassword = randomSecret("directus-db-password", { dependsOn: secretmanagerApi });
// First-boot admin account password; rotate and stop using once real staff users exist (see
// people-hub.ts's DirectusUser for ungood's own account, which doesn't need this at all). Also
// what the DirectusRole/DirectusUser/DirectusSchema dynamic resources authenticate with.
const directusAdminBootstrapPassword = randomSecret("directus-admin-bootstrap-password", {
  dependsOn: secretmanagerApi,
});
// Directus 12+ (MSCL-licensed) gates custom/relational permission rules — exactly what the
// Guardian role below needs — behind a license. CYC has one via Directus's Open Innovation Grant;
// see docs/manual-setup.md §6.
const directusLicenseKey = new Secret("directus-license-key", { dependsOn: secretmanagerApi });

for (const secret of [
  directusKey.secret,
  directusSecret.secret,
  directusDbPassword.secret,
  directusAdminBootstrapPassword.secret,
  directusLicenseKey,
]) {
  secret.grant(substrateRunner.member);
}

export { directusKey, directusSecret, directusDbPassword, directusAdminBootstrapPassword };

// The Postgres role Directus connects as — created via the Cloud SQL Admin API, which needs no
// network path to the instance.
export const directusDbUser = postgres.user("directus", directusDbPassword.value);

// Creating the role doesn't let it do anything: since Postgres 15, `public` grants CREATE only to
// the database owner (via `pg_database_owner`), so without these Directus connects fine and then
// silently fails to create its tables — `/schema/apply` returns 204 having done nothing (#112).
// These run over the IAP tunnel `just deploy` opens; they replace the manual GRANT that used to be
// docs/manual-setup.md §6.1.
const dbGrantOpts = {
  provider: postgresProvider,
  dependsOn: [directusDatabase, directusDbUser, postgresSuperuser],
};

export const directusSchemaGrant = new postgresql.Grant(
  "directus-public-schema",
  {
    database: directusDatabase.name,
    role: directusDbUser.name,
    schema: "public",
    objectType: "schema",
    privileges: ["CREATE", "USAGE"],
  },
  dbGrantOpts,
);

export const directusDatabaseGrant = new postgresql.Grant(
  "directus-database",
  {
    database: directusDatabase.name,
    role: directusDbUser.name,
    objectType: "database",
    privileges: ["CONNECT", "CREATE", "TEMPORARY"],
  },
  dbGrantOpts,
);

// Point directus.<internalDomain> at the substrate VM, same pattern as portal.ts's own record.
export const directusDnsRecord = new gcp.dns.RecordSet("directus-a", {
  name: pulumi.interpolate`directus.${internalDomain}.`,
  type: "A",
  ttl: 300,
  managedZone: internalZone.name,
  rrdatas: [address.address],
});

// --- Shared plumbing for the dynamic resources below: all of them talk to Directus's own REST
// API rather than GCP's, authenticating as the bootstrap admin (via directus-client.ts, kept
// pulumi-free so it's unit testable). This is the first place Pulumi authenticates to an
// application's own API rather than just GCP's — worth reading closely before extending it.

// Resolved (plain-value) auth props, as a dynamic provider's create/update/delete actually receive
// them — Pulumi resolves every Input<T> to a plain T before invoking the provider.
interface DirectusAuthProps {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
}

// The Input<T>-wrapped equivalent, for the public *Args interfaces resource constructors take.
interface DirectusAuthArgs {
  /** e.g. `https://directus.<internalDomain>` — no trailing slash. */
  baseUrl: pulumi.Input<string>;
  adminEmail: pulumi.Input<string>;
  /** An admin's actual password (read at apply time — see the caller for why that's a deliberate,
   * narrow exception to "Pulumi never touches secret values"). */
  adminPassword: pulumi.Input<string>;
}

// --- DirectusSchema: applies a schema snapshot (collections/fields/relations) via Directus's own
// /schema/diff + /schema/apply REST endpoints — not the `directus schema apply` CLI. Going through
// the running server's own API instead of a separate CLI process also sidesteps a real gotcha the
// CLI path has: the server's in-memory schema cache doesn't otherwise notice the change until it
// restarts. Confirmed hands-on: immediately after an API-driven apply, requests against the new
// collections succeed with no restart.

interface DirectusSchemaInputs extends DirectusAuthProps {
  /** The parsed schema snapshot (e.g. `yaml.load(readFileSync(schema.yaml))`), not a file path —
   * Pulumi needs the content itself to know when it's changed. */
  schema: unknown;
}

const directusSchemaProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DirectusSchemaInputs) {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);
    await applySchema(inputs.baseUrl, token, inputs.schema);
    return { id: "schema", outs: inputs };
  },

  async update(_id: string, _olds: DirectusSchemaInputs, news: DirectusSchemaInputs) {
    await waitForReachable(news.baseUrl);
    const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
    await applySchema(news.baseUrl, token, news.schema);
    return { outs: news };
  },

  // Deliberately a no-op: destroying this resource must not drop the app's collections (and data).
  async delete() {},
};

export interface DirectusSchemaArgs extends DirectusAuthArgs {
  schema: pulumi.Input<unknown>;
}

/** Applies a Directus schema snapshot via the REST API. One of these per Directus-backed app. */
export class DirectusSchema extends pulumi.dynamic.Resource {
  constructor(name: string, args: DirectusSchemaArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusSchemaProvider, name, { ...args }, opts);
  }
}

// --- DirectusRole: manages a Directus role + its policy + permission rules as one unit. Reusable
// across any Directus-backed app; app-specific instances (Staff/Coach/Guardian, say) live in that
// app's own file (see people-hub.ts).

export interface DirectusPermissionRule {
  collection: string;
  action: "create" | "read" | "update" | "delete";
  /** A Directus permission filter (row-level rule), e.g. a $CURRENT_USER-scoped relational filter.
   * Omit for unrestricted access to the allowed fields. Requires a license on Directus 12+. */
  permissions?: Record<string, unknown>;
  /** Defaults to every field. */
  fields?: string[];
}

interface DirectusRoleInputs extends DirectusAuthProps {
  name: string;
  icon?: string;
  description?: string;
  /** Whether users with this role can sign into the Directus Data Studio (the admin app UI) at
   * all, as opposed to API-only access. Directus policies default this to `false` — required here
   * (no default) rather than silently shipping a role nobody can actually log into. */
  appAccess: boolean;
  permissionRules: DirectusPermissionRule[];
}

interface DirectusRoleOutputs extends DirectusRoleInputs {
  roleId: string;
  policyId: string;
}

async function grantPermission(
  baseUrl: string,
  token: string,
  policyId: string,
  rule: DirectusPermissionRule,
): Promise<void> {
  await directusRequest(baseUrl, token, "POST", "/permissions", {
    policy: policyId,
    collection: rule.collection,
    action: rule.action,
    permissions: rule.permissions ?? {},
    fields: rule.fields ?? ["*"],
  });
}

/** Deletes every permission row under a policy, without touching the policy/role themselves. */
async function clearPermissions(baseUrl: string, token: string, policyId: string): Promise<void> {
  const existing = await directusRequest<{ data: { id: number }[] }>(
    baseUrl,
    token,
    "GET",
    `/permissions?filter[policy][_eq]=${policyId}&limit=-1`,
  );
  for (const permission of existing.data) {
    await directusRequest(baseUrl, token, "DELETE", `/permissions/${permission.id}`);
  }
}

const directusRoleProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DirectusRoleInputs) {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);

    const policy = await directusRequest<{ data: { id: string } }>(inputs.baseUrl, token, "POST", "/policies", {
      name: inputs.name,
      icon: inputs.icon,
      description: inputs.description,
      app_access: inputs.appAccess,
    });
    const policyId = policy.data.id;
    for (const rule of inputs.permissionRules) {
      await grantPermission(inputs.baseUrl, token, policyId, rule);
    }

    const role = await directusRequest<{ data: { id: string } }>(inputs.baseUrl, token, "POST", "/roles", {
      name: inputs.name,
      icon: inputs.icon,
      description: inputs.description,
    });
    const roleId = role.data.id;
    await directusRequest(inputs.baseUrl, token, "POST", "/access", { role: roleId, policy: policyId });

    const outs: DirectusRoleOutputs = { ...inputs, roleId, policyId };
    return { id: roleId, outs };
  },

  async update(_id: string, olds: DirectusRoleOutputs, news: DirectusRoleInputs) {
    await waitForReachable(news.baseUrl);
    const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);

    await directusRequest(news.baseUrl, token, "PATCH", `/policies/${olds.policyId}`, {
      name: news.name,
      icon: news.icon,
      description: news.description,
      app_access: news.appAccess,
    });
    await clearPermissions(news.baseUrl, token, olds.policyId);
    for (const rule of news.permissionRules) {
      await grantPermission(news.baseUrl, token, olds.policyId, rule);
    }
    await directusRequest(news.baseUrl, token, "PATCH", `/roles/${olds.roleId}`, {
      name: news.name,
      icon: news.icon,
      description: news.description,
    });

    const outs: DirectusRoleOutputs = { ...news, roleId: olds.roleId, policyId: olds.policyId };
    return { outs };
  },

  async delete(_id: string, props: DirectusRoleOutputs) {
    const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
    const access = await directusRequest<{ data: { id: string }[] }>(
      props.baseUrl,
      token,
      "GET",
      `/access?filter[role][_eq]=${props.roleId}&limit=-1`,
    );
    for (const row of access.data) {
      await directusRequest(props.baseUrl, token, "DELETE", `/access/${row.id}`);
    }
    await directusRequest(props.baseUrl, token, "DELETE", `/roles/${props.roleId}`);
    await directusRequest(props.baseUrl, token, "DELETE", `/policies/${props.policyId}`);
  },
};

export interface DirectusRoleArgs extends DirectusAuthArgs {
  name: pulumi.Input<string>;
  icon?: pulumi.Input<string>;
  description?: pulumi.Input<string>;
  /** Whether users with this role can sign into the Directus Data Studio (the admin app UI), as
   * opposed to API-only access. No default — pick `true` for a role real staff sign into the
   * Directus app with, `false` for API-only access (e.g. a future end-user-facing portal). */
  appAccess: pulumi.Input<boolean>;
  permissionRules: pulumi.Input<pulumi.Input<DirectusPermissionRule>[]>;
}

/**
 * A Directus role + its policy + permission rules, managed as one Pulumi resource. Waits (with
 * retries) for Directus to become reachable before authenticating, since it usually isn't yet the
 * moment the VM resource itself reports done.
 */
export class DirectusRole extends pulumi.dynamic.Resource {
  public readonly roleId!: pulumi.Output<string>;
  public readonly policyId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusRoleArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusRoleProvider, name, { ...args, roleId: undefined, policyId: undefined }, opts);
  }
}

// --- DirectusUser: a Directus user record linked to a Google account (via OIDC provider +
// external_identifier — the same email-matching Directus's own native OIDC config does, per
// docs/people-hub-schema.md's Auth identity section) and a role. No password: signing in via
// Google is the only way in. Reusable across any Directus-backed app.

interface DirectusUserInputs extends DirectusAuthProps {
  email: string;
  roleId: string;
  /** e.g. "google" — matches AUTH_PROVIDERS in the compose stack. */
  provider: string;
  /** The identity Directus's OIDC config matches on first login — email, for our Google setup. */
  externalIdentifier: string;
}

interface DirectusUserOutputs extends DirectusUserInputs {
  userId: string;
}

const directusUserProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DirectusUserInputs) {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);
    const user = await directusRequest<{ data: { id: string } }>(inputs.baseUrl, token, "POST", "/users", {
      email: inputs.email,
      role: inputs.roleId,
      status: "active",
      provider: inputs.provider,
      external_identifier: inputs.externalIdentifier,
    });
    const outs: DirectusUserOutputs = { ...inputs, userId: user.data.id };
    return { id: user.data.id, outs };
  },

  async update(_id: string, olds: DirectusUserOutputs, news: DirectusUserInputs) {
    await waitForReachable(news.baseUrl);
    const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
    await directusRequest(news.baseUrl, token, "PATCH", `/users/${olds.userId}`, {
      email: news.email,
      role: news.roleId,
      status: "active",
      provider: news.provider,
      external_identifier: news.externalIdentifier,
    });
    const outs: DirectusUserOutputs = { ...news, userId: olds.userId };
    return { outs };
  },

  async delete(_id: string, props: DirectusUserOutputs) {
    const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
    await directusRequest(props.baseUrl, token, "DELETE", `/users/${props.userId}`);
  },
};

export interface DirectusUserArgs extends DirectusAuthArgs {
  email: pulumi.Input<string>;
  roleId: pulumi.Input<string>;
  provider: pulumi.Input<string>;
  externalIdentifier: pulumi.Input<string>;
}

/** A Directus user provisioned for a specific Google account — no password, no manual "create my
 * account" step; signing in with that Google account just works. */
export class DirectusUser extends pulumi.dynamic.Resource {
  public readonly userId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusUserArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusUserProvider, name, { ...args, userId: undefined }, opts);
  }
}

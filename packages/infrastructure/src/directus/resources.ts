import * as pulumi from "@pulumi/pulumi";
import {
  waitForReachable,
  login,
  directusRequest,
  applySchema,
  ensurePermission,
  patchPermission,
  deletePermission,
  PermissionAction,
  PermissionRuleInput,
} from "./client.js";

// --- Shared plumbing for the dynamic resources below: all of them talk to Directus's own REST
// API rather than GCP's, authenticating as the bootstrap admin (via client.ts, kept
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

// --- DirectusRole: manages a Directus role + its policy as one unit. Reusable across any
// Directus-backed app; app-specific instances (Staff/Coach/Guardian, say) live in
// ../infrastructure/directus-roles.ts. Permission rules attach to the policy but are declared
// separately, as their own `DirectusPermissionRule` resources below - see the design doc's
// "Permission rules become their own resource" for why a role can't own them.

interface DirectusRoleInputs extends DirectusAuthProps {
  name: string;
  icon?: string;
  description?: string;
  /** Whether users with this role can sign into the Directus Data Studio (the admin app UI) at
   * all, as opposed to API-only access. Directus policies default this to `false` — required here
   * (no default) rather than silently shipping a role nobody can actually log into. */
  appAccess: boolean;
}

interface DirectusRoleOutputs extends DirectusRoleInputs {
  roleId: string;
  policyId: string;
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
}

/**
 * A Directus role + its policy, managed as one Pulumi resource. Waits (with retries) for Directus
 * to become reachable before authenticating, since it usually isn't yet the moment the VM resource
 * itself reports done.
 */
export class DirectusRole extends pulumi.dynamic.Resource {
  public readonly roleId!: pulumi.Output<string>;
  public readonly policyId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusRoleArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusRoleProvider, name, { ...args, roleId: undefined, policyId: undefined }, opts);
  }
}

// --- DirectusPermissionRule: a single permission row under a policy (one collection/action pair).
// Its own resource rather than an input on DirectusRole, so a project that doesn't own the role can
// still attach rules to its policy without a shared `update` clobbering rows another project
// declared - see the design doc's "Permission rules become their own resource".

/** The content of one permission row, independent of which row (policy, collection, action) it is.
 * Handy for building a list of rules before turning each into its own `DirectusPermissionRule`. */
export type DirectusPermissionRuleFields = PermissionRuleInput;

interface DirectusPermissionRuleInputs extends DirectusAuthProps {
  policyId: string;
  collection: string;
  action: PermissionAction;
  permissions?: Record<string, unknown>;
  fields?: string[];
}

interface DirectusPermissionRuleOutputs extends DirectusPermissionRuleInputs {
  permissionId: string;
}

const directusPermissionRuleProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DirectusPermissionRuleInputs) {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);

    // Adopts a row the old DirectusRole provider already created for this (policy, collection,
    // action) instead of posting a duplicate, and reconciles its permissions/fields to match -
    // see ensurePermission's doc comment for why adoption alone isn't enough.
    const permissionId = await ensurePermission(inputs.baseUrl, token, inputs.policyId, inputs);

    const outs: DirectusPermissionRuleOutputs = { ...inputs, permissionId };
    return { id: permissionId, outs };
  },

  async update(_id: string, olds: DirectusPermissionRuleOutputs, news: DirectusPermissionRuleInputs) {
    await waitForReachable(news.baseUrl);
    const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
    await patchPermission(news.baseUrl, token, olds.permissionId, news);

    const outs: DirectusPermissionRuleOutputs = { ...news, permissionId: olds.permissionId };
    return { outs };
  },

  async delete(_id: string, props: DirectusPermissionRuleOutputs) {
    const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
    await deletePermission(props.baseUrl, token, props.permissionId);
  },

  // (policy, collection, action) is this row's identity. Without this, the default dynamic-provider
  // diff (no replace unless told) would PATCH the existing row in place on any change, silently
  // repointing it at a different collection/action instead of creating a new row and leaving the
  // old one alone.
  async diff(_id: string, olds: DirectusPermissionRuleOutputs, news: DirectusPermissionRuleInputs) {
    const replaces = (["policyId", "collection", "action"] as const).filter((key) => olds[key] !== news[key]);
    const changes =
      replaces.length > 0 ||
      JSON.stringify(olds.permissions ?? {}) !== JSON.stringify(news.permissions ?? {}) ||
      JSON.stringify(olds.fields ?? ["*"]) !== JSON.stringify(news.fields ?? ["*"]);
    return { changes, replaces };
  },
};

export interface DirectusPermissionRuleArgs extends DirectusAuthArgs {
  policyId: pulumi.Input<string>;
  collection: pulumi.Input<string>;
  action: pulumi.Input<PermissionAction>;
  permissions?: pulumi.Input<Record<string, unknown>>;
  fields?: pulumi.Input<string[]>;
}

/** One permission row under a policy. `policyId` typically comes from a `DirectusRole`'s output,
 * but the rule itself doesn't have to be declared by whatever owns that role. */
export class DirectusPermissionRule extends pulumi.dynamic.Resource {
  public readonly permissionId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusPermissionRuleArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusPermissionRuleProvider, name, { ...args, permissionId: undefined }, opts);
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

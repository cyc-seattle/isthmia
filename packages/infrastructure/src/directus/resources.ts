import * as pulumi from "@pulumi/pulumi";
import {
  waitForReachable,
  login,
  directusRequest,
  applySchema,
  ensurePermission,
  reconcilePermission,
  deletePermission,
  PermissionAction,
  PermissionRuleInput,
  upsertUserByEmail,
  reconcileUser,
  isNotFound,
  isForbidden,
  describeProviderError,
} from "./client";

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

// Wraps a provider method (create/update/delete/diff) so whatever it throws reaches Pulumi's CLI
// as a plain Error with a message - see `describeProviderError`'s doc comment for why that isn't
// automatic. Applied at each method itself, outside any internal error handling (e.g. `DirectusUser
// .update`'s `instanceof DirectusHttpError` check), so that logic still sees the original error.
function reportErrors<Args extends unknown[], R>(
  resource: string,
  method: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw describeProviderError(resource, method, error);
    }
  };
}

// Every Directus* dynamic resource below builds its outs as `{ ...news }`, so a secret input
// (adminPassword, and DirectusUser's token) would otherwise come back out as a plain output even
// though Pulumi masks the input itself. Merges rather than replaces the caller's own opts, so a
// caller's dependsOn/parent survive.
function withSecretOutputs(keys: string[], opts?: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions {
  return { ...opts, additionalSecretOutputs: [...(opts?.additionalSecretOutputs ?? []), ...keys] };
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
  create: reportErrors("DirectusSchema", "create", async (inputs: DirectusSchemaInputs) => {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);
    await applySchema(inputs.baseUrl, token, inputs.schema);
    return { id: "schema", outs: inputs };
  }),

  update: reportErrors(
    "DirectusSchema",
    "update",
    async (_id: string, _olds: DirectusSchemaInputs, news: DirectusSchemaInputs) => {
      await waitForReachable(news.baseUrl);
      const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
      await applySchema(news.baseUrl, token, news.schema);
      return { outs: news };
    },
  ),

  // Deliberately a no-op: destroying this resource must not drop the app's collections (and data).
  delete: reportErrors("DirectusSchema", "delete", async () => {}),
};

export interface DirectusSchemaArgs extends DirectusAuthArgs {
  schema: pulumi.Input<unknown>;
}

/** Applies a Directus schema snapshot via the REST API. One of these per Directus-backed app. */
export class DirectusSchema extends pulumi.dynamic.Resource {
  constructor(name: string, args: DirectusSchemaArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusSchemaProvider, name, { ...args }, withSecretOutputs(["adminPassword"], opts));
  }
}

// --- DirectusRole: manages a Directus role + its policy as one unit. Reusable across any
// Directus-backed app; app-specific instances (Staff/Coach/Guardian, say) live in
// ../infrastructure/directus-roles.ts. Permission rules attach to the policy but are declared
// separately, as their own `DirectusPermissionRule` resources below (see there for why a role
// can't own them).

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

export const directusRoleProvider: pulumi.dynamic.ResourceProvider = {
  create: reportErrors("DirectusRole", "create", async (inputs: DirectusRoleInputs) => {
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
  }),

  update: reportErrors(
    "DirectusRole",
    "update",
    async (_id: string, olds: DirectusRoleOutputs, news: DirectusRoleInputs) => {
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
  ),

  // Tolerates the access row(s), role, or policy already being gone (#125) rather than 404-ing the
  // apply into a dead end — same spirit as DirectusAdminAccessGrant.delete below.
  delete: reportErrors("DirectusRole", "delete", async (_id: string, props: DirectusRoleOutputs) => {
    const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
    const access = await directusRequest<{ data: { id: string }[] }>(
      props.baseUrl,
      token,
      "GET",
      `/access?filter[role][_eq]=${props.roleId}&limit=-1`,
    );
    const paths = [
      ...access.data.map((row) => `/access/${row.id}`),
      `/roles/${props.roleId}`,
      `/policies/${props.policyId}`,
    ];
    for (const path of paths) {
      try {
        await directusRequest(props.baseUrl, token, "DELETE", path);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }),
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
    super(
      directusRoleProvider,
      name,
      { ...args, roleId: undefined, policyId: undefined },
      withSecretOutputs(["adminPassword"], opts),
    );
  }
}

// --- DirectusPermissionRule: a single permission row under a policy (one collection/action pair).
// Its own resource rather than an input on DirectusRole, so a project that doesn't own the role can
// still attach rules to its policy without a shared `update` clobbering rows another project
// declared.

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
  create: reportErrors("DirectusPermissionRule", "create", async (inputs: DirectusPermissionRuleInputs) => {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);

    // Adopts a row the old DirectusRole provider already created for this (policy, collection,
    // action) instead of posting a duplicate, and reconciles its permissions/fields to match -
    // see ensurePermission's doc comment for why adoption alone isn't enough.
    const permissionId = await ensurePermission(inputs.baseUrl, token, inputs.policyId, inputs);

    const outs: DirectusPermissionRuleOutputs = { ...inputs, permissionId };
    return { id: permissionId, outs };
  }),

  update: reportErrors(
    "DirectusPermissionRule",
    "update",
    async (_id: string, olds: DirectusPermissionRuleOutputs, news: DirectusPermissionRuleInputs) => {
      await waitForReachable(news.baseUrl);
      const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
      // Recreates rather than failing if the row is gone (e.g. DirectusRole.delete dropped its
      // policy, taking every row under it - possibly declared in a different stack than the one
      // deleting the policy) - mirrors ensurePermission's find-or-create-and-reconcile shape.
      const permissionId = await reconcilePermission(news.baseUrl, token, news.policyId, olds.permissionId, news);

      const outs: DirectusPermissionRuleOutputs = { ...news, permissionId };
      return { outs };
    },
  ),

  delete: reportErrors(
    "DirectusPermissionRule",
    "delete",
    async (_id: string, props: DirectusPermissionRuleOutputs) => {
      const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
      await deletePermission(props.baseUrl, token, props.permissionId);
    },
  ),

  // (policy, collection, action) is this row's identity. Without a replaces list here, the default
  // dynamic-provider diff (no replace unless told) would PATCH the existing row in place on any
  // change, silently repointing it at a different collection/action instead of creating a new row
  // and leaving the old one alone. The auth props (baseUrl/adminEmail/adminPassword) must report a
  // change too - not a replace, the row itself is unaffected by which credential wrote it - or a
  // rotated admin password (see directus.ts) is never picked up: `update` never runs, so `outs`
  // (and the credential a later `delete` authenticates with) stay frozen at whatever `create` saw.
  diff: reportErrors(
    "DirectusPermissionRule",
    "diff",
    async (_id: string, olds: DirectusPermissionRuleOutputs, news: DirectusPermissionRuleInputs) => {
      const replaces = (["policyId", "collection", "action"] as const).filter((key) => olds[key] !== news[key]);
      const authChanged = (["baseUrl", "adminEmail", "adminPassword"] as const).some((key) => olds[key] !== news[key]);
      const changes =
        replaces.length > 0 ||
        authChanged ||
        JSON.stringify(olds.permissions ?? {}) !== JSON.stringify(news.permissions ?? {}) ||
        JSON.stringify(olds.fields ?? ["*"]) !== JSON.stringify(news.fields ?? ["*"]);
      return { changes, replaces };
    },
  ),
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
    super(
      directusPermissionRuleProvider,
      name,
      { ...args, permissionId: undefined },
      withSecretOutputs(["adminPassword"], opts),
    );
  }
}

// --- DirectusUser: a Directus user record linked to a Google account (via OIDC provider +
// external_identifier — the same email-matching Directus's own native OIDC config does, per
// docs/crm-schema.md's Auth identity section) and a role. No password: signing in via
// Google is the only way in. Reusable across any Directus-backed app.

interface DirectusUserInputs extends DirectusAuthProps {
  email: string;
  roleId: string;
  /** e.g. "google" for an OIDC user, or "default" for a machine user with no interactive login. */
  provider: string;
  /** The identity Directus's OIDC config matches on first login — email, for our Google setup.
   * Omitted for a machine user, which authenticates with `token` instead. */
  externalIdentifier?: string;
  /** A Directus static access token, for a machine user in place of an interactive login. */
  token?: string;
}

interface DirectusUserOutputs extends DirectusUserInputs {
  userId: string;
  /** Whether `create` adopted a user that already existed rather than creating one. Governs whether
   * `delete` may remove the account - see the provider's delete. Absent on state written before
   * adoption existed, which is deliberately treated as "not ours to delete". */
  adopted?: boolean | undefined;
}

// A dynamic provider's `outs` crosses a protobuf Struct, which can't represent `undefined` (only a
// present key, or `null`) - an outs object with an explicit `undefined` value fails deep in the
// provider RPC layer with "Unexpected struct type." `adopted` (above) carries `undefined` forward
// from `olds` on every update once a user predates the field. Dropping the key entirely round-trips
// as "absent" on the next read, which is already what "absent" means to `adopted`'s readers.
export function omitUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function userFields(inputs: DirectusUserInputs) {
  return {
    email: inputs.email,
    role: inputs.roleId,
    status: "active",
    provider: inputs.provider,
    external_identifier: inputs.externalIdentifier,
    token: inputs.token,
  };
}

export const directusUserProvider: pulumi.dynamic.ResourceProvider = {
  create: reportErrors("DirectusUser", "create", async (inputs: DirectusUserInputs) => {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);
    const { userId, adopted } = await upsertUserByEmail(inputs.baseUrl, token, userFields(inputs));
    const outs: DirectusUserOutputs = { ...inputs, userId, adopted };
    return { id: userId, outs: omitUndefined(outs) };
  }),

  // Re-resolves by email when the stored id is gone. Without this, a user deleted out of band -
  // including by this provider's own delete during a resource rename - leaves state pointing at a
  // dead id, and every later apply fails with no way forward but editing state by hand. See
  // reconcileUser's doc comment for why it verifies the id first rather than PATCHing and catching
  // a failure.
  update: reportErrors(
    "DirectusUser",
    "update",
    async (_id: string, olds: DirectusUserOutputs, news: DirectusUserInputs) => {
      await waitForReachable(news.baseUrl);
      const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);
      const { userId, adopted } = await reconcileUser(news.baseUrl, token, olds.userId, olds.adopted, userFields(news));
      const outs = { ...news, userId, adopted } satisfies DirectusUserOutputs;
      return { outs: omitUndefined(outs) };
    },
  ),

  /**
   * Deletes the account only when this resource is the one that created it.
   *
   * Renaming a resource makes Pulumi create the new one and then delete the old, and both name the
   * same person - so the new resource adopts the existing account and the old resource's delete then
   * removes it, taking a live login with it. That is not hypothetical; it happened, and locking the
   * only Staff user out of Directus is not something a rename should be able to do.
   *
   * `adopted === undefined` means state written before adoption existed. Treated as not ours, since
   * that is exactly the state a rename is migrating away from.
   */
  delete: reportErrors("DirectusUser", "delete", async (_id: string, props: DirectusUserOutputs) => {
    if (props.adopted !== false) {
      pulumi.log.warn(
        `Leaving Directus user ${props.email} in place: this resource adopted it rather than ` +
          `creating it, so another resource may now own it. Delete it in the Data Studio if it is ` +
          `genuinely unwanted.`,
      );
      return;
    }
    const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
    // Tolerates the user already being gone (#125) — e.g. removed by hand in the Data Studio.
    // Directus answers 403 rather than 404 for a missing user id (see client.ts's isForbidden),
    // so both read as "already gone" here.
    try {
      await directusRequest(props.baseUrl, token, "DELETE", `/users/${props.userId}`);
    } catch (error) {
      if (!isNotFound(error) && !isForbidden(error)) throw error;
    }
  }),
};

export interface DirectusUserArgs extends DirectusAuthArgs {
  email: pulumi.Input<string>;
  roleId: pulumi.Input<string>;
  provider: pulumi.Input<string>;
  externalIdentifier?: pulumi.Input<string>;
  token?: pulumi.Input<string>;
}

/** A Directus user provisioned for a specific Google account — no password, no manual "create my
 * account" step; signing in with that Google account just works. */
export class DirectusUser extends pulumi.dynamic.Resource {
  public readonly userId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusUserArgs, opts?: pulumi.CustomResourceOptions) {
    super(
      directusUserProvider,
      name,
      { ...args, userId: undefined },
      withSecretOutputs(["adminPassword", "token"], opts),
    );
  }
}

// --- DirectusAdminAccessGrant: an `admin_access: true` policy attached directly to one user, via
// `/access`'s `user` key rather than its `role` key. For a per-account exception, not a privilege
// meant to flow through a role — see ../infrastructure/directus-roles.ts for the one instance.

interface DirectusAdminAccessGrantInputs extends DirectusAuthProps {
  userId: string;
  name: string;
  icon?: string;
  description?: string;
}

interface DirectusAdminAccessGrantOutputs extends DirectusAdminAccessGrantInputs {
  policyId: string;
  accessId: string;
}

const directusAdminAccessGrantProvider: pulumi.dynamic.ResourceProvider = {
  create: reportErrors("DirectusAdminAccessGrant", "create", async (inputs: DirectusAdminAccessGrantInputs) => {
    await waitForReachable(inputs.baseUrl);
    const token = await login(inputs.baseUrl, inputs.adminEmail, inputs.adminPassword);

    const policy = await directusRequest<{ data: { id: string } }>(inputs.baseUrl, token, "POST", "/policies", {
      name: inputs.name,
      icon: inputs.icon,
      description: inputs.description,
      admin_access: true,
    });
    const policyId = policy.data.id;

    const access = await directusRequest<{ data: { id: string } }>(inputs.baseUrl, token, "POST", "/access", {
      user: inputs.userId,
      policy: policyId,
    });

    const outs: DirectusAdminAccessGrantOutputs = { ...inputs, policyId, accessId: access.data.id };
    return { id: policyId, outs };
  }),

  update: reportErrors(
    "DirectusAdminAccessGrant",
    "update",
    async (_id: string, olds: DirectusAdminAccessGrantOutputs, news: DirectusAdminAccessGrantInputs) => {
      await waitForReachable(news.baseUrl);
      const token = await login(news.baseUrl, news.adminEmail, news.adminPassword);

      await directusRequest(news.baseUrl, token, "PATCH", `/policies/${olds.policyId}`, {
        name: news.name,
        icon: news.icon,
        description: news.description,
        admin_access: true,
      });

      const outs: DirectusAdminAccessGrantOutputs = { ...news, policyId: olds.policyId, accessId: olds.accessId };
      return { outs };
    },
  ),

  // Tolerates the access row or policy already being gone (#125) rather than 404-ing the apply into
  // a dead end — same spirit as DirectusUser.delete above.
  delete: reportErrors(
    "DirectusAdminAccessGrant",
    "delete",
    async (_id: string, props: DirectusAdminAccessGrantOutputs) => {
      const token = await login(props.baseUrl, props.adminEmail, props.adminPassword);
      for (const path of [`/access/${props.accessId}`, `/policies/${props.policyId}`]) {
        try {
          await directusRequest(props.baseUrl, token, "DELETE", path);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    },
  ),

  // userId is this row's identity: `/access` ties the policy to one specific user, and there's no
  // way to repoint that link in place without leaving the old user's grant dangling, so a changed
  // userId replaces rather than updates.
  diff: reportErrors(
    "DirectusAdminAccessGrant",
    "diff",
    async (_id: string, olds: DirectusAdminAccessGrantOutputs, news: DirectusAdminAccessGrantInputs) => {
      const replaces = olds.userId !== news.userId ? ["userId"] : [];
      const authChanged = (["baseUrl", "adminEmail", "adminPassword"] as const).some((key) => olds[key] !== news[key]);
      const changes =
        replaces.length > 0 ||
        authChanged ||
        olds.name !== news.name ||
        olds.icon !== news.icon ||
        olds.description !== news.description;
      return { changes, replaces };
    },
  ),
};

export interface DirectusAdminAccessGrantArgs extends DirectusAuthArgs {
  userId: pulumi.Input<string>;
  name: pulumi.Input<string>;
  icon?: pulumi.Input<string>;
  description?: pulumi.Input<string>;
}

/** Grants one user `admin_access` via a policy attached to their account directly, not to a role. */
export class DirectusAdminAccessGrant extends pulumi.dynamic.Resource {
  public readonly policyId!: pulumi.Output<string>;
  public readonly accessId!: pulumi.Output<string>;

  constructor(name: string, args: DirectusAdminAccessGrantArgs, opts?: pulumi.CustomResourceOptions) {
    super(
      directusAdminAccessGrantProvider,
      name,
      { ...args, policyId: undefined, accessId: undefined },
      withSecretOutputs(["adminPassword"], opts),
    );
  }
}

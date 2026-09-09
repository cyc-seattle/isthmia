import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { postgres } from "./database";
import { address, substrateRunner } from "./compute";
import { internalDomain, internalZone } from "./dns";
import { Secret } from "./secret";
import { enableService } from "./services";

// Directus itself: the substrate for the people hub (and any future app that wants a
// relationship-based permission engine — see docs/architecture.md). Runs on the substrate VM
// against its own database on the shared Cloud SQL instance. One database for the whole instance,
// not one per app — Directus's own collections are how data is organized within it.
//
// App-specific schema/roles (e.g. the people hub's) live in that app's own file — see
// people-hub.ts — built on the DirectusRole resource this file exports.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

export const directusDatabase = postgres.database("directus");

// Directus's own secrets. The Google OAuth client is shared platform-wide (substrate.ts), not
// declared here — signing in once should sign into every surface on the substrate, not just this
// one. Values set out of band, same pattern as portal.ts.
const secrets = {
  // Directus's own encryption/signing secrets (its `KEY`/`SECRET` env vars).
  "directus-key": new Secret("directus-key", { dependsOn: secretmanagerApi }),
  "directus-secret": new Secret("directus-secret", { dependsOn: secretmanagerApi }),
  "directus-db-password": new Secret("directus-db-password", { dependsOn: secretmanagerApi }),
  // First-boot admin account password; rotate and stop using once real staff users exist. Also
  // what the DirectusRole dynamic resources below authenticate with to create roles/policies.
  "directus-admin-bootstrap-password": new Secret("directus-admin-bootstrap-password", {
    dependsOn: secretmanagerApi,
  }),
  // Directus 12+ (MSCL-licensed) gates custom/relational permission rules — exactly what the
  // Guardian role below needs — behind a license. CYC has one via Directus's Open Innovation
  // Grant; see docs/manual-setup.md §6. Optional at the Pulumi level (Directus runs on the Core
  // tier if empty), but required for the Guardian role to actually work.
  "directus-license-key": new Secret("directus-license-key", { dependsOn: secretmanagerApi }),
};

for (const secret of Object.values(secrets)) {
  secret.grant(substrateRunner.member);
}

// Point crm.<internalDomain> at the substrate VM, same pattern as portal.ts's own record.
export const directusDnsRecord = new gcp.dns.RecordSet("directus-a", {
  name: pulumi.interpolate`crm.${internalDomain}.`,
  type: "A",
  ttl: 300,
  managedZone: internalZone.name,
  rrdatas: [address.address],
});

// --- DirectusRole: a Pulumi dynamic resource managing a Directus role + its policy + permission
// rules as one unit, via Directus's REST API. Reusable across any Directus-backed app; app-specific
// instances (Staff/Coach/Guardian, say) live in that app's own file (see people-hub.ts).
//
// This is the first dynamic resource in this repo, and the first place Pulumi authenticates to an
// application's own API rather than just GCP's — worth reading closely before extending it.

export interface DirectusPermissionRule {
  collection: string;
  action: "create" | "read" | "update" | "delete";
  /** A Directus permission filter (row-level rule), e.g. a $CURRENT_USER-scoped relational filter.
   * Omit for unrestricted access to the allowed fields. Requires a license on Directus 12+. */
  permissions?: Record<string, unknown>;
  /** Defaults to every field. */
  fields?: string[];
}

interface DirectusRoleInputs {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  name: string;
  icon?: string;
  description?: string;
  permissionRules: DirectusPermissionRule[];
}

interface DirectusRoleOutputs extends DirectusRoleInputs {
  roleId: string;
  policyId: string;
}

// This package's tsconfig (@tsconfig/node20, lib: es2023, no DOM) hits an @types/node quirk where
// the ambient `fetch`/`Response` types resolve to an empty structural type rather than undici's
// real one (its conditional type meant to defer to DOM lib's Response misfires with no DOM lib
// present either). Rather than cast at every call site, wrap `fetch` once with the shape we
// actually use.
interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

async function httpFetch(input: string, init?: RequestInit): Promise<HttpResponse> {
  return (await fetch(input, init)) as unknown as HttpResponse;
}

async function waitForReachable(baseUrl: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpFetch(`${baseUrl}/server/ping`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Directus at ${baseUrl} did not become reachable within ${timeoutMs}ms (VM boot/DNS/TLS may still be in ` +
      `progress — re-run \`pulumi up\` once it's up). Last error: ${String(lastError)}`,
  );
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await httpFetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Directus login as ${email} failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { data: { access_token: string } }).data.access_token;
}

async function directusRequest<T>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await httpFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
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

export interface DirectusRoleArgs {
  /** e.g. `https://crm.<internalDomain>` — no trailing slash. */
  baseUrl: pulumi.Input<string>;
  adminEmail: pulumi.Input<string>;
  /** The `directus-admin-bootstrap-password` secret's actual value (read at apply time — see the
   * caller for why that's a deliberate, narrow exception to "Pulumi never touches secret values"). */
  adminPassword: pulumi.Input<string>;
  name: pulumi.Input<string>;
  icon?: pulumi.Input<string>;
  description?: pulumi.Input<string>;
  permissionRules: pulumi.Input<pulumi.Input<DirectusPermissionRule>[]>;
}

/**
 * A Directus role + its policy + permission rules, managed as one Pulumi resource. Waits (with
 * retries) for Directus to become reachable before authenticating, since it usually isn't yet the
 * moment the VM resource itself reports done.
 */
export class DirectusRole extends pulumi.dynamic.Resource {
  constructor(name: string, args: DirectusRoleArgs, opts?: pulumi.CustomResourceOptions) {
    super(directusRoleProvider, name, { ...args, roleId: undefined, policyId: undefined }, opts);
  }
}

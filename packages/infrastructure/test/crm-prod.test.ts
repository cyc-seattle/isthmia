import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// Prod's Directus on the cluster keeps what it had on the VM (#231). on-cluster.test.ts covers dev,
// and on-cluster-prod.test.ts prod's Authentik and portal.

const platform = {
  project: "test-project",
  projectNumber: "123",
  region: "us-west1",
  cluster: "cluster",
  clusterEndpoint: "cluster.example.com",
  namespace: "prod",
  gateway: { name: "gateway", namespace: "infra" },
  domain: "example.com",
  sqlConnectionName: "test-project:us-west1:prod-sql",
  sqlHost: "10.1.2.3",
  gatewayAddress: "203.0.113.1",
  registry: "us-west1-docker.pkg.dev/test-project/images",
};

interface Registered {
  type: string;
  name: string;
  inputs: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  opts: Record<string, unknown>;
}

const resources: Registered[] = [];
const secretReads: unknown[] = [];

pulumi.runtime.setMocks(
  {
    newResource: ({ type, name, inputs }) => {
      resources.push({ type, name, inputs, opts: {} });
      const state =
        type === "pulumi:pulumi:StackReference"
          ? {
              ...inputs,
              outputs: {
                directusOidcClientSecret: "oidc-secret",
                internalDomain: "example.com",
                publicIp: "198.51.100.7",
                directusBaseUrl: "https://directus.example.com",
                internalZoneName: "zone",
                postgresInstanceName: "prod-sql",
              },
            }
          : { ...inputs, hex: `${name}-hex`, result: `${name}-value`, roleId: `${name}-role-id` };
      return { id: `${name}-id`, state };
    },
    call: ({ token, inputs }) => {
      if (token === "gcp:storage/getBucketObjectContent:getBucketObjectContent") {
        return { ...inputs, content: JSON.stringify(platform) };
      }
      if (token === "gcp:secretmanager/getSecretVersionAccess:getSecretVersionAccess") {
        secretReads.push(inputs["secret"]);
        return { ...inputs, secretData: "license" };
      }
      return inputs;
    },
  },
  "isthmia",
  "prod",
  false,
);
pulumi.runtime.setConfig("gcp:project", "test-project");
// The mocks name the project `isthmia`, so its config is crm's.
pulumi.runtime.setConfig("isthmia:directusCpu", "500m");
pulumi.runtime.setConfig("isthmia:directusMemory", "1Gi");
pulumi.runtime.setConfig("isthmia:safeToEvict", "false");

function find(type: string, name: string): Registered {
  const found = resources.find((r) => r.type === type && r.name === name);
  if (!found) throw new Error(`No ${type} named ${name}. Registered: ${resources.map((r) => r.name).join(", ")}`);
  return found;
}

function container() {
  return find("kubernetes:apps/v1:Deployment", "directus").inputs["spec"].template.spec;
}

/** A Secret's data, which the mocks see wrapped as a secret when any value in it is one. */
function stringData(name: string): Record<string, unknown> {
  const data = find("kubernetes:core/v1:Secret", name).inputs["stringData"];
  return "value" in data ? data.value : data;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  const { prodDirectus } = await import("../src/crm/prod-state.js");
  const { deployDirectus } = await import("../src/crm/cluster.js");
  const prod = prodDirectus({
    adminEmail: "admin@example.com",
    admins: [],
    externalDomain: "example.org",
    baseUrl: "https://directus.example.com",
  });
  // vitest's class fields shadow a dynamic resource's outputs, so the role's ID is set here.
  const values = { ...prod.values, communityRoleId: pulumi.output("community-role") };
  await deployDirectus("admin@example.com", true, values);
  await settle();
});

describe("prod's Directus on the cluster", () => {
  it("runs one replica that Autopilot won't move to consolidate nodes", () => {
    const { spec } = find("kubernetes:apps/v1:Deployment", "directus").inputs;
    expect(spec.replicas).toBe(1);
    expect(spec.template.metadata.annotations).toEqual({ "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" });
  });

  it("points directus. at the Gateway", () => {
    const records = resources.filter((r) => r.type === "gcp:dns/recordSet:RecordSet");
    expect(records.map((r) => r.inputs)).toEqual([
      expect.objectContaining({ name: "directus.example.com.", rrdatas: [platform.gatewayAddress] }),
    ]);
  });

  it("keeps the VM's keys and database password", () => {
    expect(stringData("directus")).toMatchObject({
      KEY: "directus-key-value-hex",
      SECRET: "directus-secret-value-hex",
      ADMIN_PASSWORD: "directus-admin-bootstrap-password-value-hex",
      LICENSE_KEY: "license",
    });
    expect(stringData("directus-db")).toMatchObject({
      password: "directus-db-password-value-hex",
      host: platform.sqlHost,
    });
  });

  it("generates no second database user, key, password, or Community role ID", () => {
    expect(resources.filter((r) => r.type === "gcp:sql/user:User").map((r) => r.name)).toEqual(["directus-user"]);
    const generated = resources.filter((r) => r.type.startsWith("random:") && !r.type.endsWith("RandomBytes"));
    expect(generated).toEqual([]);
  });

  it("reads prod's license key", () => {
    expect(secretReads).toEqual(["directus-license-key"]);
  });

  it("names the existing Community role as the default, and in the query guard", () => {
    const env = Object.fromEntries(
      container().containers[0].env.map((e: { name: string; value?: unknown }) => [e.name, e.value]),
    );
    expect(env).toMatchObject({
      AUTH_AUTHENTIK_DEFAULT_ROLE_ID: "community-role",
      PUBLIC_URL: "https://directus.example.com",
      DB_POOL__MAX: "10",
    });
    const guard = find("kubernetes:core/v1:ConfigMap", "directus-community-query-guard").inputs["data"];
    expect(JSON.parse(guard["config.json"]).role).toBe("community-role");
  });

  it("runs on regular capacity with prod's sizing", () => {
    expect(container().nodeSelector).toEqual({});
    expect(container().containers[0].resources.requests).toEqual({ cpu: "500m", memory: "1Gi" });
  });
});

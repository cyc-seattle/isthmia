import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

const platform = {
  project: "test-project",
  projectNumber: "123",
  region: "us-west1",
  cluster: "cluster",
  clusterEndpoint: "cluster.example.com",
  namespace: "prod",
  gateway: { name: "gateway", namespace: "infra" },
  domain: "example.com",
  sqlConnectionName: "test-project:us-west1:cyc-prod",
  sqlHost: "10.1.2.4",
  gatewayAddress: "203.0.113.1",
  registry: "us-west1-docker.pkg.dev/test-project/images",
};

interface Registered {
  type: string;
  name: string;
  inputs: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const resources: Registered[] = [];
const calls: { token: string; inputs: Record<string, unknown> }[] = [];

pulumi.runtime.setMocks(
  {
    newResource: ({ type, name, inputs }) => {
      resources.push({ type, name, inputs });
      const state =
        type === "pulumi:pulumi:StackReference"
          ? { ...inputs, outputs: { internalZoneName: "zone", postgresInstanceName: "instance" } }
          : { ...inputs, hex: `${name}-hex` };
      return { id: `${name}-id`, state };
    },
    call: ({ token, inputs }) => {
      calls.push({ token, inputs });
      if (token === "gcp:storage/getBucketObjectContent:getBucketObjectContent") {
        return { ...inputs, content: JSON.stringify(platform) };
      }
      return inputs;
    },
  },
  "isthmia",
  "prod",
  false,
);
pulumi.runtime.setConfig("gcp:project", "test-project");
pulumi.runtime.setConfig("isthmia:safeToEvict", "false");

function find(type: string, name: string): Registered {
  const found = resources.find((r) => r.type === type && r.name === name);
  if (!found) throw new Error(`No ${type} named ${name}. Registered: ${resources.map((r) => r.name).join(", ")}`);
  return found;
}

function container(deployment: string) {
  return find("kubernetes:apps/v1:Deployment", deployment).inputs["spec"].template.spec.containers[0];
}

function env(deployment: string): Record<string, unknown> {
  return Object.fromEntries(
    (container(deployment).env ?? []).map((e: { name: string; value?: unknown }) => [e.name, e.value]),
  );
}

// The mock passes secret values through wrapped, as `{ <signature>, value }`.
function stringData(secret: string): Record<string, unknown> {
  return find("kubernetes:core/v1:Secret", secret).inputs["stringData"].value;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  // Imported after setMocks, since the modules read the stack name when they load.
  const { prodSecrets } = await import("../src/authentik/prod-secrets.js");
  const { deployAuthentik } = await import("../src/authentik/cluster.js");
  await deployAuthentik(prodSecrets());
  await settle();
});

describe("Authentik on prod's cluster", () => {
  it("keeps the VM's secrets, generating none", () => {
    expect(resources.filter((r) => r.type === "random:index/randomPassword:RandomPassword")).toEqual([]);
    expect(stringData("authentik")).toMatchObject({
      AUTHENTIK_SECRET_KEY: "authentik-secret-key-value-hex",
      AUTHENTIK_BOOTSTRAP_TOKEN: "authentik-bootstrap-token-value-hex",
    });
  });

  it("keeps the VM's database and user, creating no others", () => {
    expect(resources.filter((r) => r.type.startsWith("gcp:sql/")).map((r) => r.name)).toEqual([
      "authentik-user",
      "authentik-db",
    ]);
    expect(stringData("authentik-db")).toMatchObject({
      host: "10.1.2.4",
      uri: "postgres://authentik:authentik-db-password-value-hex@10.1.2.4:5432/authentik",
    });
  });

  it("sends mail through the Workspace relay, with no Mailpit", () => {
    expect(env("authentik-worker")).toMatchObject({
      AUTHENTIK_EMAIL__HOST: "smtp-relay.gmail.com",
      AUTHENTIK_EMAIL__PORT: "587",
      AUTHENTIK_EMAIL__USE_TLS: "true",
    });
    expect(resources.find((r) => r.name === "mailpit")).toBeUndefined();
  });

  it("keeps prod's server processes and worker threads", () => {
    expect(env("authentik-server")).toMatchObject({ AUTHENTIK_WEB__WORKERS: "2", AUTHENTIK_WEB__THREADS: "2" });
    expect(env("authentik-worker")).toMatchObject({ AUTHENTIK_WORKER__THREADS: "2" });
  });

  it("still closes prod's database connections after each request", () => {
    expect(env("authentik-server")).toMatchObject({ AUTHENTIK_POSTGRESQL__CONN_MAX_AGE: "0" });
    expect(env("authentik-server")).not.toHaveProperty("AUTHENTIK_POSTGRESQL__CONN_HEALTH_CHECKS");
  });

  it("checks the server's readiness at dev's cadence, to cut its database load", () => {
    const probe = find("kubernetes:apps/v1:Deployment", "authentik-server").inputs["spec"].template.spec.containers[0]
      .readinessProbe;
    expect(probe).toEqual({ httpGet: { path: "/-/health/ready/", port: 9000 }, periodSeconds: 30, timeoutSeconds: 10 });
    expect(
      find("kubernetes:networking.gke.io/v1:HealthCheckPolicy", "authentik-server").inputs["spec"].default,
    ).toMatchObject({
      checkIntervalSec: 30,
      timeoutSec: 10,
      config: { httpHealthCheck: { requestPath: "/static/dist/assets/icons/icon.png" } },
    });
  });

  it("keeps the server's memory at 1Gi, above its peak, and lets both burst", () => {
    // Autopilot gives a pod it won't evict at least 500m CPU, so a smaller request shows a change on
    // every deploy (cyc-seattle/platform#104).
    const resources = (name: string) =>
      find("kubernetes:apps/v1:Deployment", name).inputs["spec"].template.spec.containers[0].resources;
    expect(resources("authentik-server")).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "1", memory: "1Gi" },
    });
    expect(resources("authentik-worker")).toEqual({
      requests: { cpu: "100m", memory: "512Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    });
  });

  it("keeps the server off node consolidation, leaving the worker movable", () => {
    const template = (name: string) => find("kubernetes:apps/v1:Deployment", name).inputs["spec"].template;
    expect(template("authentik-server").metadata.annotations).toEqual({
      "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
    });
    expect(template("authentik-worker").metadata.annotations).toBeUndefined();
  });

  it("points login. at the Gateway", () => {
    expect(find("gcp:dns/recordSet:RecordSet", "authentik-a").inputs).toMatchObject({
      name: "login.example.com.",
      rrdatas: ["203.0.113.1"],
    });
  });
});

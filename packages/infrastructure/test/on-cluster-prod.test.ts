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
      if (token === "gcp:artifactregistry/getDockerImage:getDockerImage") {
        return { ...inputs, selfLink: `${platform.registry}/portal@sha256:abc` };
      }
      return inputs;
    },
  },
  "isthmia",
  "prod",
  false,
);
pulumi.runtime.setConfig("gcp:project", "test-project");
// The mocks name the project `isthmia`, so its config is the portal's.
pulumi.runtime.setConfig("isthmia:replicas", "2");
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
  // `export =` comes through as the default export.
  const { default: portal } = (await import("../src/portal/index.js")) as unknown as {
    default: () => Promise<unknown>;
  };
  await deployAuthentik(prodSecrets());
  await portal();
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
    expect(env("authentik-server")).toMatchObject({ AUTHENTIK_WEB__WORKERS: "2" });
    expect(env("authentik-worker")).toMatchObject({ AUTHENTIK_WORKER__THREADS: "2" });
  });

  it("keeps the server's default readiness timing", () => {
    const probe = find("kubernetes:apps/v1:Deployment", "authentik-server").inputs["spec"].template.spec.containers[0]
      .readinessProbe;
    expect(probe).toEqual({ httpGet: { path: "/-/health/ready/", port: 9000 } });
    expect(
      find("kubernetes:networking.gke.io/v1:HealthCheckPolicy", "authentik-server").inputs["spec"].default,
    ).not.toHaveProperty("checkIntervalSec");
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

describe("The portal on prod's cluster", () => {
  it("runs the image dev built for this commit, by digest", () => {
    const lookup = calls.find((c) => c.token === "gcp:artifactregistry/getDockerImage:getDockerImage");
    expect(lookup?.inputs).toMatchObject({ location: "us-west1", project: "test-project", repositoryId: "images" });
    expect(lookup?.inputs["imageName"]).toMatch(/^portal:[0-9a-f]{40}$/);
    expect(container("portal").image).toBe(`${platform.registry}/portal@sha256:abc`);
    expect(resources.find((r) => r.type === "docker-build:index:Image")).toBeUndefined();
  });

  it("runs two replicas across zones, one always up through a drain", () => {
    const { spec } = find("kubernetes:apps/v1:Deployment", "portal").inputs;
    expect(spec.replicas).toBe(2);
    expect(spec.template.spec.topologySpreadConstraints).toEqual([
      expect.objectContaining({ topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway" }),
    ]);
    expect(find("kubernetes:policy/v1:PodDisruptionBudget", "portal").inputs["spec"]).toMatchObject({
      minAvailable: 1,
    });
  });

  it("points the apex at the Gateway", () => {
    expect(find("gcp:dns/recordSet:RecordSet", "portal-a").inputs).toMatchObject({
      name: "example.com.",
      rrdatas: ["203.0.113.1"],
    });
  });
});

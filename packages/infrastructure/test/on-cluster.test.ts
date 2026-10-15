import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

const platform = {
  project: "test-project",
  projectNumber: "123",
  region: "us-west1",
  cluster: "cluster",
  clusterEndpoint: "cluster.example.com",
  namespace: "dev",
  gateway: { name: "gateway", namespace: "infra" },
  domain: "dev.example.com",
  sqlConnectionName: "test-project:us-west1:cyc-dev",
  sqlHost: "10.1.2.3",
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
          ? { ...inputs, outputs: { directusOidcClientSecret: "oidc-secret" } }
          : { ...inputs, result: `${name}-value`, ref: `${name}@sha256:abc` };
      return { id: `${name}-id`, state };
    },
    call: ({ token, inputs }) => {
      calls.push({ token, inputs });
      if (token === "gcp:storage/getBucketObjectContent:getBucketObjectContent") {
        return { ...inputs, content: JSON.stringify(platform) };
      }
      if (token === "gcp:secretmanager/getSecretVersionAccess:getSecretVersionAccess") {
        const secret = String(inputs["secret"]);
        return { ...inputs, secretData: secret.startsWith("dev-db-") ? "pa$$word" : "license" };
      }
      return inputs;
    },
  },
  "isthmia",
  "dev",
  false,
);
pulumi.runtime.setConfig("gcp:project", "test-project");

function find(type: string, name: string): Registered {
  const found = resources.find((r) => r.type === type && r.name === name);
  if (!found) throw new Error(`No ${type} named ${name}. Registered: ${resources.map((r) => r.name).join(", ")}`);
  return found;
}

function container(deployment: string) {
  return find("kubernetes:apps/v1:Deployment", deployment).inputs["spec"].template.spec.containers[0];
}

function envNames(deployment: string): Record<string, unknown> {
  return Object.fromEntries(
    (container(deployment).env ?? []).map((e: { name: string; value?: unknown }) => [e.name, e.value]),
  );
}

function secretReads(): unknown[] {
  return calls
    .filter((c) => c.token === "gcp:secretmanager/getSecretVersionAccess:getSecretVersionAccess")
    .map((c) => c.inputs["secret"]);
}

// Lets the registrations an awaited deploy queued reach the mocks.
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  // Imported after setMocks, since the modules read the stack name when they load.
  const { deployAuthentik } = await import("../src/authentik/cluster.js");
  const { deployDirectus } = await import("../src/crm/cluster.js");
  await deployAuthentik();
  await deployDirectus("admin@example.com", true);
  await settle();
});

describe("Authentik on the cluster", () => {
  it("uses the database platform made in dev, creating none of its own", () => {
    expect(resources.filter((r) => r.type.startsWith("gcp:sql/"))).toEqual([]);
    expect(secretReads()).toContain("dev-db-authentik-password");
    // The mock passes secret values through wrapped, as `{ <signature>, value }`.
    expect(find("kubernetes:core/v1:Secret", "authentik-db").inputs["stringData"].value).toMatchObject({
      host: "10.1.2.3",
      database: "authentik",
      username: "authentik",
      uri: "postgres://authentik:pa%24%24word@10.1.2.3:5432/authentik",
    });
  });

  it("runs the server and the worker, sending mail to Mailpit in dev", () => {
    expect(container("authentik-server").args).toEqual(["server"]);
    expect(container("authentik-worker").args).toEqual(["worker"]);
    expect(envNames("authentik-worker")).toMatchObject({
      AUTHENTIK_POSTGRESQL__HOST: "10.1.2.3",
      AUTHENTIK_EMAIL__HOST: "mailpit",
      AUTHENTIK_EMAIL__PORT: "1025",
    });
    expect(container("mailpit").image).toMatch(/^axllent\/mailpit:v/);
  });

  it("mounts the email templates where the email stage looks", () => {
    const mounts = container("authentik-worker").volumeMounts.map((m: { mountPath: string }) => m.mountPath);
    expect(mounts).toEqual(expect.arrayContaining(["/templates/email", "/dev/shm"]));
  });

  it("serves login.<domain> with the redirects beside it", () => {
    const route = find("kubernetes:gateway.networking.k8s.io/v1:HTTPRoute", "authentik-server");
    expect(route.inputs["spec"].hostnames).toEqual(["login.dev.example.com"]);
    expect(find("kubernetes:gateway.networking.k8s.io/v1:HTTPRoute", "authentik-login-redirects")).toBeDefined();
  });
});

describe("Directus on the cluster", () => {
  it("reads dev's license key and database password", () => {
    expect(secretReads()).toEqual(expect.arrayContaining(["dev-directus-license-key", "dev-db-directus-password"]));
  });

  it("probes /server/ping, which Directus answers without a sign-in", () => {
    expect(container("directus").readinessProbe.httpGet.path).toBe("/server/ping");
  });

  it("reads the OIDC client secret from authentik's stack in the same environment", () => {
    expect(find("pulumi:pulumi:StackReference", "organization/authentik/dev")).toBeDefined();
  });

  it("keeps its connection pool small", () => {
    expect(envNames("directus")).toMatchObject({ DB_POOL__MAX: "5", PUBLIC_URL: "https://directus.dev.example.com" });
  });
});

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
          ? { ...inputs, outputs: { clubspotSyncToken: "clubspot-token", gsuiteSyncToken: "gsuite-token" } }
          : inputs;
      return { id: `${name}-id`, state };
    },
    call: ({ token, inputs }) => {
      calls.push({ token, inputs });
      if (token === "gcp:storage/getBucketObjectContent:getBucketObjectContent") {
        return { ...inputs, content: JSON.stringify(platform) };
      }
      if (token === "gcp:artifactregistry/getDockerImage:getDockerImage") {
        const name = String(inputs["imageName"]).split(":")[0];
        return { ...inputs, selfLink: `${platform.registry}/${name}@sha256:abc` };
      }
      if (token === "gcp:secretmanager/getSecretVersionAccess:getSecretVersionAccess") {
        return { ...inputs, secretData: `${String(inputs["secret"])}-value` };
      }
      return inputs;
    },
  },
  "isthmia",
  "prod",
  false,
);
pulumi.runtime.setConfig("gcp:project", "test-project");
// The mocks name the project `isthmia`, so its config is both syncs'.
pulumi.runtime.setConfig("isthmia:onCluster", "true");
pulumi.runtime.setConfig("isthmia:clubId", "club01");
pulumi.runtime.setConfig("isthmia:groupOwners", "owner@example.com");
pulumi.runtime.setConfig("isthmia:workspaceCustomer", "C123");

function find(type: string, name: string): Registered {
  const found = resources.find((r) => r.type === type && r.name === name);
  if (!found) throw new Error(`No ${type} named ${name}. Registered: ${resources.map((r) => r.name).join(", ")}`);
  return found;
}

function cronJob(name: string) {
  return find("kubernetes:batch/v1:CronJob", name).inputs["spec"];
}

function container(name: string) {
  return cronJob(name).jobTemplate.spec.template.spec.containers[0];
}

function env(name: string): Record<string, unknown> {
  return Object.fromEntries(
    (container(name).env ?? []).map((e: { name: string; value?: unknown }) => [e.name, e.value]),
  );
}

// The mock passes secret values through wrapped, as `{ <signature>, value }`.
function stringData(secret: string): Record<string, unknown> {
  return find("kubernetes:core/v1:Secret", secret).inputs["stringData"].value;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  // Imported after setMocks, since the modules read the stack name when they load. `export =` comes
  // through as the default export.
  type Program = { default: () => Promise<unknown> };
  const { default: clubspotSync } = (await import("../src/clubspot-sync/index.js")) as unknown as Program;
  const { default: gsuiteSync } = (await import("../src/gsuite-sync/index.js")) as unknown as Program;
  await clubspotSync();
  await gsuiteSync();
  await settle();
});

describe("The syncs on prod's cluster", () => {
  it("run the images dev built for this commit, by digest, building none", () => {
    expect(container("clubspot-sync").image).toBe(`${platform.registry}/clubspot-sync@sha256:abc`);
    expect(container("gsuite-sync").image).toBe(`${platform.registry}/gsuite-sync@sha256:abc`);
    expect(resources.find((r) => r.type === "docker-build:index:Image")).toBeUndefined();
  });

  it("start no fakes", () => {
    expect(resources.filter((r) => r.type === "kubernetes:apps/v1:Deployment")).toEqual([]);
    expect(resources.find((r) => r.type.startsWith("gcp:sql/"))).toBeUndefined();
  });

  it("run hourly, half an hour apart, never overlapping", () => {
    expect(cronJob("clubspot-sync")).toMatchObject({ schedule: "0 * * * *", concurrencyPolicy: "Forbid" });
    expect(cronJob("gsuite-sync")).toMatchObject({ schedule: "30 * * * *", concurrencyPolicy: "Forbid" });
  });

  it("run on regular capacity, not Spot", () => {
    expect(cronJob("clubspot-sync").jobTemplate.spec.template.spec.nodeSelector).toEqual({});
    expect(cronJob("gsuite-sync").jobTemplate.spec.template.spec.nodeSelector).toEqual({});
  });

  it("reach Directus inside the namespace", () => {
    expect(env("clubspot-sync")["DIRECTUS_URL"]).toBe("http://directus");
    expect(env("gsuite-sync")["DIRECTUS_URL"]).toBe("http://directus");
  });
});

describe("clubspot-sync on prod's cluster", () => {
  it("syncs the club from Clubspot's own server", () => {
    expect(env("clubspot-sync")).toEqual({ CLUBSPOT_CLUB_ID: "club01", DIRECTUS_URL: "http://directus" });
  });

  it("reads the Clubspot login from Secret Manager, and its token from crm", () => {
    expect(stringData("clubspot-sync")).toEqual({
      DIRECTUS_TOKEN: "clubspot-token",
      CLUBSPOT_EMAIL: "clubspot-username-value",
      CLUBSPOT_PASSWORD: "clubspot-password-value",
    });
  });
});

describe("gsuite-sync on prod's cluster", () => {
  it("calls Google's own APIs", () => {
    expect(env("gsuite-sync")).toEqual({
      DIRECTUS_URL: "http://directus",
      GSUITE_SYNC_GROUP_OWNERS: "owner@example.com",
      GSUITE_SYNC_CUSTOMER: "C123",
    });
  });

  it("acts as gsuite-sync@ through Workload Identity", () => {
    expect(find("kubernetes:core/v1:ServiceAccount", "gsuite-sync").inputs["metadata"].annotations).toEqual({
      "iam.gke.io/gcp-service-account": "gsuite-sync@test-project.iam.gserviceaccount.com",
    });
    expect(find("kubernetes:core/v1:ServiceAccount", "clubspot-sync").inputs["metadata"].annotations).toBeUndefined();
  });

  it("reads its token from crm", () => {
    expect(stringData("gsuite-sync")).toEqual({ DIRECTUS_TOKEN: "gsuite-token" });
  });
});

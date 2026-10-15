import * as pulumi from "@pulumi/pulumi";
import { ScheduledJob, Workload } from "@cyc-seattle/platform";
import { appImage, appSecret, isDev, loadCluster, onCluster, siblingSecret } from "../cluster";

// gsuite-sync on the cluster (#231): an hourly CronJob that reaches Directus inside the namespace.
// In dev it syncs into the Workspace fake, which keeps its state in memory and ignores auth.

// Renovate bumps it with @cyc-seattle/gsuite-sdk, which publishes the fake.
const fakeImage = "ghcr.io/cyc-seattle/workspace-fake:0.3.0";

export = async () => {
  if (!onCluster()) {
    return {};
  }
  if (!isDev) {
    throw new Error("gsuite-sync runs on the cluster in dev only until its prod move (#231).");
  }
  const config = new pulumi.Config();
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  new Workload("workspace-fake", {
    platform,
    provider,
    image: fakeImage,
    ports: [{ name: "http", port: 8080 }],
    requests: { cpu: "50m", memory: "128Mi" },
    readinessProbe: { httpGet: { path: "/healthz", port: 8080 } },
    env: [{ name: "NEW_GROUP_DELAY_MS", value: "0" }],
  });

  const secret = appSecret(cluster, "gsuite-sync", {
    DIRECTUS_TOKEN: siblingSecret("crm", "gsuiteSyncToken"),
  });

  const image = appImage(cluster, "gsuite-sync", { context: "../../../..", target: "gsuite-sync" });

  new ScheduledJob("gsuite-sync", {
    platform,
    provider,
    image: image.ref,
    // Half past, so it doesn't run alongside clubspot-sync in dev's small quota.
    schedule: "30 * * * *",
    requests: { cpu: "250m", memory: "512Mi" },
    env: [
      { name: "DIRECTUS_URL", value: "http://directus" },
      { name: "GSUITE_ROOT_URL", value: "http://workspace-fake:8080" },
      { name: "GSUITE_SYNC_GROUP_OWNERS", value: config.require("groupOwners") },
      { name: "GSUITE_SYNC_CUSTOMER", value: config.require("workspaceCustomer") },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
  });

  return {};
};

import * as pulumi from "@pulumi/pulumi";
import { ScheduledJob, Workload } from "@cyc-seattle/platform";
import { appSecret, deployedImage, isDev, loadCluster, siblingSecret } from "../cluster";
import { enableService } from "../services";

// gsuite-sync on the cluster (#231): an hourly CronJob that reaches Directus inside the namespace.
// In dev it syncs into the Workspace fake, which keeps its state in memory and ignores auth. In prod
// it calls the Workspace APIs as gsuite-sync@, through Workload Identity.

// Renovate bumps it with @cyc-seattle/gsuite-sdk, which publishes the fake.
const fakeImage = "ghcr.io/cyc-seattle/workspace-fake:0.3.0";

export = async () => {
  if (!isDev) {
    // The Directory API, for group membership, nesting, and roles, and the Groups Settings API.
    // Dev's sync calls the Workspace fake instead.
    enableService("admin.googleapis.com");
    enableService("groupssettings.googleapis.com");
  }
  const config = new pulumi.Config();
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  if (isDev) {
    new Workload("workspace-fake", {
      platform,
      provider,
      image: fakeImage,
      ports: [{ name: "http", port: 8080 }],
      requests: { cpu: "50m", memory: "128Mi" },
      readinessProbe: { httpGet: { path: "/healthz", port: 8080 } },
      env: [{ name: "NEW_GROUP_DELAY_MS", value: "0" }],
    });
  }

  const secret = appSecret(cluster, "gsuite-sync", {
    DIRECTUS_TOKEN: siblingSecret("crm", "gsuiteSyncToken"),
  });

  const image = deployedImage(cluster, "gsuite-sync", { context: "../../../..", target: "gsuite-sync" });

  new ScheduledJob("gsuite-sync", {
    platform,
    provider,
    image,
    // Half past, so it doesn't run alongside clubspot-sync, and passes on the hour's changes within
    // half an hour.
    schedule: "30 * * * *",
    requests: { cpu: "250m", memory: "512Mi" },
    env: [
      { name: "DIRECTUS_URL", value: "http://directus" },
      ...(isDev ? [{ name: "GSUITE_ROOT_URL", value: "http://workspace-fake:8080" }] : []),
      { name: "GSUITE_SYNC_GROUP_OWNERS", value: config.require("groupOwners") },
      { name: "GSUITE_SYNC_CUSTOMER", value: config.require("workspaceCustomer") },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
    // gsuite-sync@ holds the Groups Administrator role in Workspace. platform's bootstrap lets this
    // ServiceAccount act as it (#231).
    ...(!isDev && {
      serviceAccountAnnotations: {
        "iam.gke.io/gcp-service-account": `gsuite-sync@${platform.project}.iam.gserviceaccount.com`,
      },
    }),
  });

  return {};
};

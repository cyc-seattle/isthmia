import * as pulumi from "@pulumi/pulumi";
import { ScheduledJob, Workload } from "@cyc-seattle/platform";
import { appDatabase, appImage, appSecret, isDev, loadCluster, onCluster, siblingSecret } from "../cluster";
import { clubspotFakeEnv } from "./fake";

// clubspot-sync on the cluster (#231): an hourly CronJob that reaches Directus inside the namespace.
// In dev it syncs from the Clubspot fake, on its own database on the dev instance.

// Renovate bumps it with @cyc-seattle/clubspot-sdk, which publishes the fake.
const fakeImage = "ghcr.io/cyc-seattle/clubspot-fake:0.3.0";

export = async () => {
  if (!onCluster()) {
    return {};
  }
  if (!isDev) {
    throw new Error("clubspot-sync runs on the cluster in dev only until its prod move (#231).");
  }
  const config = new pulumi.Config();
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  const db = appDatabase(cluster, "clubspot_fake");
  new Workload("clubspot-fake", {
    platform,
    provider,
    image: fakeImage,
    ports: [{ name: "parse", port: 1337 }],
    requests: { cpu: "100m", memory: "256Mi" },
    // 200 only once the seed has finished.
    readinessProbe: { httpGet: { path: "/ready", port: 1337 } },
    env: clubspotFakeEnv(db.host, db.secret.metadata.name),
    volumes: [{ name: "tmp", mountPath: "/tmp", emptyDir: {} }],
  });

  const secret = appSecret(cluster, "clubspot-sync", {
    DIRECTUS_TOKEN: siblingSecret("crm", "clubspotSyncToken"),
    CLUBSPOT_PASSWORD: config.requireSecret("clubspotPassword"),
  });

  const image = appImage(cluster, "clubspot-sync", { context: "../../../..", target: "clubspot-sync" });

  new ScheduledJob("clubspot-sync", {
    platform,
    provider,
    image: image.ref,
    // Hourly matches BASE_INTERVAL_MS in backoff.ts, so a camp that just wrote something is due again
    // on the very next run.
    schedule: "0 * * * *",
    requests: { cpu: "250m", memory: "512Mi" },
    env: [
      { name: "CLUBSPOT_SERVER_URL", value: "http://clubspot-fake:1337/parse" },
      { name: "CLUBSPOT_CLUB_ID", value: config.require("clubId") },
      { name: "CLUBSPOT_EMAIL", value: config.require("clubspotEmail") },
      { name: "DIRECTUS_URL", value: "http://directus" },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
  });

  return {};
};

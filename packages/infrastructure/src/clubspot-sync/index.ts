import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { ScheduledJob, Workload } from "@cyc-seattle/platform";
import { appDatabase, appSecret, type Cluster, deployedImage, isDev, loadCluster, siblingSecret } from "../cluster";
import { clubspotFakeDatabaseUri, clubspotFakeEnv } from "./fake";
import { Secret } from "../secret";

// clubspot-sync on the cluster (#231): an hourly CronJob that reaches Directus inside the namespace.
// In dev it syncs from the Clubspot fake, on its own database on the dev instance. In prod it syncs
// from Clubspot, with the login set by hand in Secret Manager.

// Renovate bumps it with @cyc-seattle/clubspot-sdk, which publishes the fake.
const fakeImage = "ghcr.io/cyc-seattle/clubspot-fake:0.3.0";

export = async () => {
  if (!isDev) {
    // Set by hand. The deploy reads them into the CronJob's Secret.
    new Secret("clubspot-username");
    new Secret("clubspot-password");
  }
  const config = new pulumi.Config();
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  const clubspot = isDev ? clubspotFake(cluster, config) : clubspotLogin();

  const secret = appSecret(cluster, "clubspot-sync", {
    DIRECTUS_TOKEN: siblingSecret("crm", "clubspotSyncToken"),
    CLUBSPOT_EMAIL: clubspot.email,
    CLUBSPOT_PASSWORD: clubspot.password,
  });

  const image = deployedImage(cluster, "clubspot-sync", { context: "../../../..", target: "clubspot-sync" });

  new ScheduledJob("clubspot-sync", {
    platform,
    provider,
    image,
    // Hourly matches BASE_INTERVAL_MS in backoff.ts, so a camp that just wrote something is due again
    // on the very next run.
    schedule: "0 * * * *",
    requests: { cpu: "250m", memory: "512Mi" },
    env: [
      ...(clubspot.serverUrl === undefined ? [] : [{ name: "CLUBSPOT_SERVER_URL", value: clubspot.serverUrl }]),
      { name: "CLUBSPOT_CLUB_ID", value: config.require("clubId") },
      { name: "DIRECTUS_URL", value: "http://directus" },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
  });

  return {};
};

interface ClubspotLogin {
  /** Unset for Clubspot's own server. */
  serverUrl?: string;
  email: pulumi.Input<string>;
  password: pulumi.Output<string>;
}

function clubspotLogin(): ClubspotLogin {
  const read = (secret: string) =>
    pulumi.secret(gcp.secretmanager.getSecretVersionAccessOutput({ secret }).apply((version) => version.secretData));
  return { email: read("clubspot-username"), password: read("clubspot-password") };
}

/** The Clubspot fake, on its own database, and its seed's login. */
function clubspotFake(cluster: Cluster, config: pulumi.Config): ClubspotLogin {
  const { platform, provider } = cluster;
  const db = appDatabase(cluster, "clubspot_fake");
  const fakeDb = appSecret(cluster, "clubspot-fake", { uri: db.uri.apply(clubspotFakeDatabaseUri) });
  new Workload("clubspot-fake", {
    platform,
    provider,
    image: fakeImage,
    ports: [{ name: "parse", port: 1337 }],
    requests: { cpu: "100m", memory: "256Mi" },
    // 200 only once the seed has finished.
    readinessProbe: { httpGet: { path: "/ready", port: 1337 } },
    env: clubspotFakeEnv(fakeDb.metadata.name),
    volumes: [{ name: "tmp", mountPath: "/tmp", emptyDir: {} }],
  });
  return {
    serverUrl: "http://clubspot-fake:1337/parse",
    email: config.require("clubspotEmail"),
    password: config.requireSecret("clubspotPassword"),
  };
}

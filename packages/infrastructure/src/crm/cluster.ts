import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { WebService } from "@cyc-seattle/platform";
import { appDatabase, appSecret, isDev, loadCluster, secretEnv, siblingSecret } from "../cluster";
import { directusEnv } from "./workloads";
import { queryGuardConfig } from "./community-rules";

// Directus on the cluster (#231). Its uploads are ephemeral, as on the VM.

const image = "directus/directus:12.3.1";

export interface DirectusOnCluster {
  baseUrl: string;
  adminPassword: pulumi.Output<string>;
  /** Directus names it as the default role at start, before `crm` creates the role with this ID. */
  communityRoleId: pulumi.Output<string>;
  /** Resolves once Directus answers at `baseUrl`. */
  ready: pulumi.Resource;
}

function generated(name: string, length: number): pulumi.Output<string> {
  return new random.RandomPassword(name, { length, special: false }).result;
}

/** `licensed` false runs Directus on its unlicensed Core tier, with no `LICENSE_KEY`. */
export async function deployDirectus(adminEmail: string, licensed: boolean): Promise<DirectusOnCluster> {
  const cluster = await loadCluster();
  const { platform, provider } = cluster;
  const domain = platform.domain;
  const baseUrl = `https://directus.${domain}`;

  const db = appDatabase(cluster, "directus");
  const adminPassword = generated("directus-admin-password", 32);
  const communityRoleId = new random.RandomUuid("directus-community-role-id").result;
  // Set by hand in Secret Manager; dev's has its own name (#172). The Access variant needs only the
  // accessor role, which is all deploy-dev holds.
  const licenseKey = licensed
    ? gcp.secretmanager
        .getSecretVersionAccessOutput({ secret: `${isDev ? "dev-" : ""}directus-license-key` })
        .apply((version) => version.secretData)
    : undefined;
  const oidcClientSecret = siblingSecret("authentik", "directusOidcClientSecret");

  const secret = appSecret(cluster, "directus", {
    KEY: generated("directus-key", 64),
    SECRET: generated("directus-secret", 64),
    ADMIN_PASSWORD: adminPassword,
    ...(licenseKey && { LICENSE_KEY: pulumi.secret(licenseKey) }),
    AUTH_AUTHENTIK_CLIENT_SECRET: oidcClientSecret,
  });

  // Directus loads extensions only at start. Unnamed, so a change replaces it under a new name, and
  // the Deployment rolls.
  const queryGuard = new k8s.core.v1.ConfigMap(
    "directus-community-query-guard",
    {
      metadata: { namespace: platform.namespace },
      data: {
        "package.json": JSON.stringify({
          name: "community-query-guard",
          version: "1.0.0",
          "directus:extension": { type: "hook", path: "index.js", source: "index.js", host: "^12.0.0" },
        }),
        "index.js": readFileSync(resolve(__dirname, "community-query-guard.js"), "utf8"),
        "config.json": communityRoleId.apply((role) => JSON.stringify({ role, ...queryGuardConfig() })),
      },
    },
    { provider },
  );

  const directus = new WebService("directus", {
    platform,
    provider,
    hostname: `directus.${domain}`,
    image,
    port: 8055,
    requests: { cpu: "250m", memory: "768Mi" },
    // Directus 12 answers /server/health only to a signed-in caller, so probes would never pass.
    readinessProbe: { httpGet: { path: "/server/ping", port: 8055 } },
    env: [
      ...directusEnv({ domain, adminEmail, dbHost: db.host, communityRoleId }),
      secretEnv("DB_PASSWORD", db.secret, "password"),
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
    // Where Directus writes: pm2's state, uploads, and the bundled app extensions.
    volumes: [
      { name: "pm2", mountPath: "/home/node/.pm2", emptyDir: {} },
      { name: "uploads", mountPath: "/directus/uploads", emptyDir: { sizeLimit: "1Gi" } },
      { name: "extensions", mountPath: "/directus/node_modules/.directus", emptyDir: {} },
      {
        name: "community-query-guard",
        mountPath: "/directus/extensions/community-query-guard",
        configMap: queryGuard.metadata.name,
        readOnly: true,
      },
    ],
    // The image's user is `node`, a name, which runAsNonRoot can't check.
    runAsUser: 1000,
  });

  // The load balancer takes minutes to admit a new route, longer than the Directus resources wait.
  const ready = new command.local.Command(
    "directus-ready",
    {
      create: 'curl -fsS -o /dev/null --retry 90 --retry-delay 10 --retry-all-errors "$DIRECTUS_URL/server/ping"',
      environment: { DIRECTUS_URL: baseUrl },
      // A changed Secret replaces the Deployment too, so Directus restarts.
      triggers: [image, secret.metadata.uid, queryGuard.metadata.uid],
    },
    { dependsOn: directus },
  );

  return { baseUrl, adminPassword: pulumi.secret(adminPassword), communityRoleId, ready };
}

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as command from "@pulumi/command";
import * as random from "@pulumi/random";
import { WebService, Workload } from "@cyc-seattle/platform";
import { appDatabase, appSecret, isDev, loadCluster, secretEnv } from "../cluster";
import { dnsRecord } from "../cloud";
import { authentikEnv, loginRedirectRoute } from "./workloads";
import { builtInQueries } from "./naming";
import type { AuthentikSecrets } from "./prod-secrets";

// Authentik on the cluster (#231): its database, its generated secrets, the server and worker, and
// in dev, Mailpit in place of the Workspace relay.

const image = "ghcr.io/goauthentik/server:2026.8.3";
const mailpitImage = "axllent/mailpit:v1.31.5";

export interface AuthentikOnCluster {
  domain: string;
  url: string;
  bootstrapToken: pulumi.Output<string>;
  /** Resolves once the API answers with the bootstrap token at `url`. */
  ready: command.local.Command;
}

function generated(name: string, length: number): pulumi.Output<string> {
  return new random.RandomPassword(name, { length, special: false }).result;
}

/**
 * Authentik in the environment's namespace. `existing` holds prod's secrets and database password
 * from the VM, which an instance on the same database must keep. Without it, as in dev, they're new.
 */
export async function deployAuthentik(
  existing?: AuthentikSecrets & { dbPassword: pulumi.Output<string> },
): Promise<AuthentikOnCluster> {
  const cluster = await loadCluster();
  const { platform, provider } = cluster;
  const domain = platform.domain;
  const url = `https://login.${domain}`;

  const db = appDatabase(cluster, "authentik", existing?.dbPassword);
  const secrets: AuthentikSecrets = existing ?? {
    secretKey: generated("authentik-secret-key", 64),
    bootstrapToken: generated("authentik-bootstrap-token", 64),
    bootstrapPassword: generated("authentik-bootstrap-password", 32),
  };
  const bootstrapToken = pulumi.secret(secrets.bootstrapToken);
  const secret = appSecret(cluster, "authentik", {
    AUTHENTIK_SECRET_KEY: pulumi.secret(secrets.secretKey),
    AUTHENTIK_BOOTSTRAP_TOKEN: bootstrapToken,
    AUTHENTIK_BOOTSTRAP_PASSWORD: pulumi.secret(secrets.bootstrapPassword),
  });

  // Mounted at /templates/email, since the email stage names its template `email/<name>.html`.
  const templatesDir = resolve(__dirname, "templates/email");
  const templates = new k8s.core.v1.ConfigMap(
    "authentik-templates",
    {
      metadata: { name: "authentik-templates", namespace: platform.namespace },
      data: Object.fromEntries(
        readdirSync(templatesDir).map((name) => [name, readFileSync(resolve(templatesDir, name), "utf8")]),
      ),
    },
    { provider },
  );

  let smtp: { host: string; port: number; useTls: boolean } = { host: "smtp-relay.gmail.com", port: 587, useTls: true };
  if (isDev) {
    new Workload("mailpit", {
      platform,
      provider,
      image: mailpitImage,
      ports: [
        { name: "smtp", port: 1025 },
        { name: "http", port: 8025 },
      ],
      requests: { cpu: "50m", memory: "64Mi" },
      readinessProbe: { httpGet: { path: "/readyz", port: 8025 } },
      // Its message store is a temporary SQLite file.
      volumes: [{ name: "tmp", mountPath: "/tmp", emptyDir: {} }],
      // The image runs as root by default.
      runAsUser: 1000,
    });
    smtp = { host: "mailpit", port: 1025, useTls: false };
  }

  const env = authentikEnv({
    dbHost: db.host,
    dbPassword: secretEnv("AUTHENTIK_POSTGRESQL__PASSWORD", db.secret, "password"),
    smtp,
  });
  // Authentik keeps its sockets and Prometheus files in TMPDIR, /dev/shm. Nothing else writes.
  const volumes = [
    { name: "shm", mountPath: "/dev/shm", emptyDir: { sizeLimit: "256Mi" } },
    { name: "templates", mountPath: "/templates/email", configMap: templates.metadata.name, readOnly: true },
  ];

  // Each server process and worker thread holds its own connections, even with CONN_MAX_AGE=0, so
  // dev runs fewer to fit db-f1-micro's ~25 beside Directus and Parse.
  const server = new WebService("authentik-server", {
    platform,
    provider,
    hostname: `login.${domain}`,
    image,
    args: ["server"],
    port: 9000,
    requests: { cpu: "500m", memory: "1Gi" },
    readinessProbe: { httpGet: { path: "/-/health/ready/", port: 9000 } },
    env: [
      ...env,
      { name: "AUTHENTIK_WEB__WORKERS", value: isDev ? "1" : "2" },
      { name: "AUTHENTIK_WEB__THREADS", value: "2" },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
    volumes,
    // Keeps Autopilot from moving it to consolidate nodes (#253). One replica fits the quota.
    ...(new pulumi.Config().getBoolean("safeToEvict") === false && {
      podAnnotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" },
    }),
  });

  // The bootstrap token takes effect when the worker first starts.
  const worker = new Workload("authentik-worker", {
    platform,
    provider,
    image,
    args: ["worker"],
    // At 250m, a fresh instance's worker took over 15 minutes to apply the built-in blueprints.
    requests: { cpu: "500m", memory: "512Mi" },
    env: [
      ...env,
      { name: "AUTHENTIK_WORKER__PROCESSES", value: "1" },
      { name: "AUTHENTIK_WORKER__THREADS", value: isDev ? "1" : "2" },
    ],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
    volumes,
  });

  new k8s.apiextensions.CustomResource(
    "authentik-login-redirects",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "authentik-login-redirects", namespace: platform.namespace },
      spec: loginRedirectRoute(platform.gateway, domain),
    },
    { provider },
  );

  // Dev's hostnames are under platform's wildcard record. Prod's record moved here from the VM.
  const record = isDev ? [] : [dnsRecord("authentik-a", `login.${domain}`, platform.gatewayAddress)];

  // A ready pod isn't enough: the load balancer takes minutes to admit a new route, the worker
  // applies the bootstrap token after it starts, and it creates the built-in flows and mappings this
  // project looks up in the background after that. The Authentik provider needs all of them.
  const ready = new command.local.Command(
    "authentik-api-ready",
    {
      create: ["../../../../scripts/wait-for-authentik", ...builtInQueries().map((q) => `'${q}'`)].join(" "),
      environment: { AUTHENTIK_URL: url, AUTHENTIK_TOKEN: bootstrapToken },
      triggers: [image],
    },
    { dependsOn: [server, worker, ...record] },
  );

  return {
    domain,
    url,
    bootstrapToken,
    ready,
  };
}

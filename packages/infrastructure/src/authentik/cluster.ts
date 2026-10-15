import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as command from "@pulumi/command";
import * as random from "@pulumi/random";
import { WebService, Workload } from "@cyc-seattle/platform";
import { appDatabase, appSecret, isDev, loadCluster, secretEnv } from "../cluster";
import { authentikEnv, loginRedirectRoute } from "./workloads";

// Authentik on the cluster (#231): its database, its generated secrets, the server and worker, and
// in dev, Mailpit in place of the Workspace relay.

const image = "ghcr.io/goauthentik/server:2026.8.3";
const mailpitImage = "axllent/mailpit:v1.31.5";

export interface AuthentikOnCluster {
  domain: string;
  url: string;
  bootstrapToken: pulumi.Output<string>;
  directusOidcClientSecret: pulumi.Output<string>;
  /** Resolves once the API answers with the bootstrap token at `url`. */
  ready: pulumi.Resource;
}

function generated(name: string, length: number): pulumi.Output<string> {
  return new random.RandomPassword(name, { length, special: false }).result;
}

export async function deployAuthentik(): Promise<AuthentikOnCluster> {
  const cluster = await loadCluster();
  const { platform, provider } = cluster;
  const domain = platform.domain;
  const url = `https://login.${domain}`;

  const db = appDatabase(cluster, "authentik");
  const bootstrapToken = generated("authentik-bootstrap-token", 64);
  const secret = appSecret(cluster, "authentik", {
    AUTHENTIK_SECRET_KEY: generated("authentik-secret-key", 64),
    AUTHENTIK_BOOTSTRAP_TOKEN: bootstrapToken,
    AUTHENTIK_BOOTSTRAP_PASSWORD: generated("authentik-bootstrap-password", 32),
  });

  // Mounted at /templates/email, since the email stage names its template `email/<name>.html`.
  const templatesDir = resolve(__dirname, "../../../substrate/deploy/authentik-templates/email");
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

  const server = new WebService("authentik-server", {
    platform,
    provider,
    hostname: `login.${domain}`,
    image,
    args: ["server"],
    port: 9000,
    requests: { cpu: "500m", memory: "1Gi" },
    readinessProbe: { httpGet: { path: "/-/health/ready/", port: 9000 } },
    env: [...env, { name: "AUTHENTIK_WEB__WORKERS", value: "2" }, { name: "AUTHENTIK_WEB__THREADS", value: "2" }],
    envFrom: [{ secretRef: { name: secret.metadata.name, optional: false } }],
    volumes,
  });

  // The bootstrap token takes effect when the worker first starts.
  const worker = new Workload("authentik-worker", {
    platform,
    provider,
    image,
    args: ["worker"],
    requests: { cpu: "250m", memory: "768Mi" },
    env: [
      ...env,
      { name: "AUTHENTIK_WORKER__PROCESSES", value: "1" },
      { name: "AUTHENTIK_WORKER__THREADS", value: "2" },
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

  // A ready pod isn't enough: the load balancer takes minutes to admit a new route, and the worker
  // applies the bootstrap token after it starts. The Authentik provider needs both.
  const ready = new command.local.Command(
    "authentik-api-ready",
    {
      create:
        'curl -fsS -o /dev/null --retry 90 --retry-delay 10 --retry-all-errors -H "Authorization: Bearer $AUTHENTIK_TOKEN" "$AUTHENTIK_URL/api/v3/core/users/me/"',
      environment: { AUTHENTIK_URL: url, AUTHENTIK_TOKEN: bootstrapToken },
      triggers: [image],
    },
    { dependsOn: [server, worker] },
  );

  return {
    domain,
    url,
    bootstrapToken,
    directusOidcClientSecret: pulumi.secret(generated("directus-oidc-client-secret", 64)),
    ready,
  };
}

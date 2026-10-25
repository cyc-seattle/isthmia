import type * as k8s from "@pulumi/kubernetes";

type EnvVar = k8s.types.input.core.v1.EnvVar;

// Pure builders for the on-cluster Authentik (./cluster.ts), testable without Pulumi.

/**
 * The defaults plus the Google load balancer's proxy ranges. Authentik trusts X-Forwarded-Proto only
 * from these, and without it builds `http://` issuer and redirect URLs, which Directus rejects.
 */
export const TRUSTED_PROXY_CIDRS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fe80::/10",
  "::1/128",
  "35.191.0.0/16",
  "130.211.0.0/22",
].join(",");

export interface AuthentikEnvArgs {
  dbHost: string;
  dbPassword: EnvVar;
  smtp: { host: string; port: number; useTls: boolean };
  /** A transaction-mode pooler in front of `dbHost`, which then serves only what needs a session. */
  poolerHost?: string;
}

/** The env both the server and the worker take, as in the VM's compose file. */
export function authentikEnv({ dbHost, dbPassword, smtp, poolerHost }: AuthentikEnvArgs): EnvVar[] {
  const db: EnvVar[] = poolerHost
    ? [
        { name: "AUTHENTIK_POSTGRESQL__HOST", value: poolerHost },
        // LISTEN and the worker's advisory locks need a session, which a transaction pooler can't keep.
        { name: "AUTHENTIK_POSTGRESQL__DIRECT__HOST", value: dbHost },
        { name: "AUTHENTIK_POSTGRESQL__DISABLE_SERVER_SIDE_CURSORS", value: "true" },
      ]
    : [{ name: "AUTHENTIK_POSTGRESQL__HOST", value: dbHost }];
  return [
    ...db,
    { name: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
    { name: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
    dbPassword,
    { name: "AUTHENTIK_POSTGRESQL__CONN_MAX_AGE", value: "0" },
    { name: "AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS", value: TRUSTED_PROXY_CIDRS },
    { name: "AUTHENTIK_EMAIL__HOST", value: smtp.host },
    { name: "AUTHENTIK_EMAIL__PORT", value: String(smtp.port) },
    { name: "AUTHENTIK_EMAIL__USE_TLS", value: String(smtp.useTls) },
    { name: "AUTHENTIK_EMAIL__FROM", value: "noreply@cyccommunitysailing.org" },
  ];
}

/**
 * PgBouncer's env, for edoburu/pgbouncer's entrypoint: a transaction pool that opens at most
 * `poolSize` connections to Authentik's database, however many requests Authentik serves at once.
 */
export function authentikPoolerEnv({
  dbHost,
  dbPassword,
  poolSize,
}: {
  dbHost: string;
  dbPassword: EnvVar;
  poolSize: number;
}): EnvVar[] {
  return [
    { name: "DB_HOST", value: dbHost },
    { name: "DB_NAME", value: "authentik" },
    { name: "DB_USER", value: "authentik" },
    dbPassword,
    { name: "AUTH_TYPE", value: "scram-sha-256" },
    { name: "POOL_MODE", value: "transaction" },
    { name: "DEFAULT_POOL_SIZE", value: String(poolSize) },
    { name: "MAX_DB_CONNECTIONS", value: String(poolSize) },
    // Closes idle server connections after a minute, rather than PgBouncer's ten.
    { name: "SERVER_IDLE_TIMEOUT", value: "60" },
  ];
}

/**
 * The `login.` host's redirects, as the VM's Caddyfile has them: Authentik's "Go home" lands on `/`,
 * which it sends on to an empty `/if/user/` dashboard, so both go to the portal's public page. Exact
 * matches outrank the server's own route for the rest of the host.
 */
export function loginRedirectRoute(gateway: { name: string; namespace: string }, domain: string) {
  const redirect = {
    type: "RequestRedirect",
    requestRedirect: {
      scheme: "https",
      hostname: domain,
      path: { type: "ReplaceFullPath", replaceFullPath: "/welcome" },
      statusCode: 302,
    },
  };
  return {
    parentRefs: [{ name: gateway.name, namespace: gateway.namespace }],
    hostnames: [`login.${domain}`],
    rules: ["/", "/if/user/"].map((value) => ({
      matches: [{ path: { type: "Exact", value } }],
      filters: [redirect],
    })),
  };
}

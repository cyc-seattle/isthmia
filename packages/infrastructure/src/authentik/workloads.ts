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
}

/** The env both the server and the worker take, as in the VM's compose file. */
export function authentikEnv({ dbHost, dbPassword, smtp }: AuthentikEnvArgs): EnvVar[] {
  return [
    { name: "AUTHENTIK_POSTGRESQL__HOST", value: dbHost },
    { name: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
    { name: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
    dbPassword,
    // Keeps Authentik, Directus, and Parse under db-f1-micro's ~25 connections.
    { name: "AUTHENTIK_POSTGRESQL__CONN_MAX_AGE", value: "0" },
    { name: "AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS", value: TRUSTED_PROXY_CIDRS },
    { name: "AUTHENTIK_EMAIL__HOST", value: smtp.host },
    { name: "AUTHENTIK_EMAIL__PORT", value: String(smtp.port) },
    { name: "AUTHENTIK_EMAIL__USE_TLS", value: String(smtp.useTls) },
    { name: "AUTHENTIK_EMAIL__FROM", value: "noreply@cyccommunitysailing.org" },
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

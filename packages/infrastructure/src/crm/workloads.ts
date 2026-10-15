import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";

type EnvVar = k8s.types.input.core.v1.EnvVar;

// A pure builder for the on-cluster Directus (./cluster.ts), testable without Pulumi.

export interface DirectusEnvArgs {
  domain: string;
  adminEmail: string;
  dbHost: string;
  communityRoleId: pulumi.Input<string>;
}

/** Directus's env, as in the VM's compose file, without the secrets. */
export function directusEnv({ domain, adminEmail, dbHost, communityRoleId }: DirectusEnvArgs): EnvVar[] {
  const site = `https://${domain}`;
  const values: Record<string, pulumi.Input<string>> = {
    DB_CLIENT: "pg",
    DB_HOST: dbHost,
    DB_PORT: "5432",
    DB_DATABASE: "directus",
    DB_USER: "directus",
    // db-f1-micro allows about 25 connections across Authentik, Directus, and Parse.
    DB_POOL__MIN: "0",
    DB_POOL__MAX: "5",
    ADMIN_EMAIL: adminEmail,
    PUBLIC_URL: `https://directus.${domain}`,
    // The built-in admin is the break-glass login if Authentik is down (#166).
    AUTH_PROVIDERS: "authentik",
    AUTH_AUTHENTIK_DRIVER: "openid",
    AUTH_AUTHENTIK_CLIENT_ID: "directus",
    AUTH_AUTHENTIK_ISSUER_URL: `https://login.${domain}/application/o/directus/`,
    AUTH_AUTHENTIK_IDENTIFIER_KEY: "email",
    // The portal's roster calls Directus with fetch, which needs a session cookie, not a refresh token.
    AUTH_AUTHENTIK_MODE: "session",
    AUTH_AUTHENTIK_ALLOW_PUBLIC_REGISTRATION: "true",
    AUTH_AUTHENTIK_DEFAULT_ROLE_ID: communityRoleId,
    AUTH_AUTHENTIK_REDIRECT_ALLOW_LIST: site,
    CORS_ENABLED: "true",
    CORS_ORIGIN: site,
    CORS_CREDENTIALS: "true",
    // An admin still turns MCP on in Settings -> AI (#152).
    MCP_OAUTH_ENABLED: "true",
    MCP_OAUTH_CIMD_ENABLED: "true",
  };
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

import { describe, expect, it } from "vitest";
import {
  authentikEnv,
  authentikPoolerEnv,
  loginRedirectRoute,
  TRUSTED_PROXY_CIDRS,
} from "../src/authentik/workloads.js";
import { directusEnv } from "../src/crm/workloads.js";
import { clubspotFakeDatabaseUri, clubspotFakeEnv } from "../src/clubspot-sync/fake.js";
import { databaseSecretName, databaseUri } from "../src/cluster.js";

function envMap(env: { name: unknown; value?: unknown }[]): Record<string, unknown> {
  return Object.fromEntries(env.map(({ name, value }) => [name, value]));
}

describe("authentikEnv", () => {
  const dbPassword = { name: "AUTHENTIK_POSTGRESQL__PASSWORD", valueFrom: { secretKeyRef: { name: "s", key: "k" } } };

  it("sends mail to Mailpit without TLS", () => {
    const env = envMap(
      authentikEnv({ dbHost: "10.0.0.5", dbPassword, smtp: { host: "mailpit", port: 1025, useTls: false } }),
    );

    expect(env).toMatchObject({
      AUTHENTIK_POSTGRESQL__HOST: "10.0.0.5",
      AUTHENTIK_EMAIL__HOST: "mailpit",
      AUTHENTIK_EMAIL__PORT: "1025",
      AUTHENTIK_EMAIL__USE_TLS: "false",
      AUTHENTIK_POSTGRESQL__CONN_MAX_AGE: "0",
    });
  });

  it("sends all but session-scoped traffic through a pooler, when there is one", () => {
    const env = envMap(
      authentikEnv({
        dbHost: "10.0.0.5",
        dbPassword,
        smtp: { host: "mailpit", port: 1025, useTls: false },
        poolerHost: "authentik-pgbouncer",
      }),
    );

    expect(env).toMatchObject({
      AUTHENTIK_POSTGRESQL__HOST: "authentik-pgbouncer",
      AUTHENTIK_POSTGRESQL__DIRECT__HOST: "10.0.0.5",
      AUTHENTIK_POSTGRESQL__DISABLE_SERVER_SIDE_CURSORS: "true",
    });
  });

  it("trusts the load balancer's proxies", () => {
    expect(TRUSTED_PROXY_CIDRS.split(",")).toEqual(expect.arrayContaining(["35.191.0.0/16", "130.211.0.0/22"]));
  });
});

describe("authentikPoolerEnv", () => {
  it("caps the transaction pool's connections to the database", () => {
    const dbPassword = { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "s", key: "k" } } };
    const env = authentikPoolerEnv({ dbHost: "10.0.0.5", dbPassword, poolSize: 3 });

    expect(env).toContainEqual(dbPassword);
    expect(envMap(env)).toMatchObject({
      DB_HOST: "10.0.0.5",
      DB_NAME: "authentik",
      DB_USER: "authentik",
      AUTH_TYPE: "scram-sha-256",
      POOL_MODE: "transaction",
      DEFAULT_POOL_SIZE: "3",
      MAX_DB_CONNECTIONS: "3",
    });
  });
});

describe("loginRedirectRoute", () => {
  it("sends / and /if/user/ to the portal's welcome page", () => {
    const route = loginRedirectRoute({ name: "gateway", namespace: "infra" }, "dev.example.com");

    expect(route.hostnames).toEqual(["login.dev.example.com"]);
    expect(route.rules.map((rule) => rule.matches[0]?.path)).toEqual([
      { type: "Exact", value: "/" },
      { type: "Exact", value: "/if/user/" },
    ]);
    for (const rule of route.rules) {
      expect(rule.filters[0]?.requestRedirect).toEqual({
        scheme: "https",
        hostname: "dev.example.com",
        path: { type: "ReplaceFullPath", replaceFullPath: "/welcome" },
        statusCode: 302,
      });
    }
  });
});

describe("directusEnv", () => {
  it("points Directus at its hostnames and the default role", () => {
    const env = envMap(
      directusEnv({
        domain: "dev.example.com",
        adminEmail: "admin@example.com",
        dbHost: "10.0.0.5",
        communityRoleId: "r",
        poolMax: 7,
      }),
    );

    expect(env).toMatchObject({
      PUBLIC_URL: "https://directus.dev.example.com",
      AUTH_AUTHENTIK_ISSUER_URL: "https://login.dev.example.com/application/o/directus/",
      AUTH_AUTHENTIK_DEFAULT_ROLE_ID: "r",
      CORS_ORIGIN: "https://dev.example.com",
      AUTH_AUTHENTIK_REDIRECT_ALLOW_LIST: "https://dev.example.com",
      DB_HOST: "10.0.0.5",
      DB_POOL__MAX: "7",
    });
  });
});

describe("clubspotFakeEnv", () => {
  it("reads the database URI from a Secret", () => {
    expect(clubspotFakeEnv("clubspot-fake")).toEqual([
      { name: "PARSE_SERVER_DATABASE_URI", valueFrom: { secretKeyRef: { name: "clubspot-fake", key: "uri" } } },
    ]);
  });

  it("caps Parse's pool", () => {
    expect(clubspotFakeDatabaseUri("postgres://u:p@10.0.0.5:5432/clubspot_fake")).toBe(
      "postgres://u:p@10.0.0.5:5432/clubspot_fake?max=2",
    );
  });
});

describe("databaseUri", () => {
  it("escapes the password", () => {
    expect(databaseUri("10.0.0.5", "clubspot_fake", "p@ss/w:rd")).toBe(
      "postgres://clubspot_fake:p%40ss%2Fw%3Ard@10.0.0.5:5432/clubspot_fake",
    );
  });
});

describe("databaseSecretName", () => {
  it("replaces underscores, which Kubernetes names can't hold", () => {
    expect(databaseSecretName("clubspot_fake")).toBe("clubspot-fake-db");
  });
});

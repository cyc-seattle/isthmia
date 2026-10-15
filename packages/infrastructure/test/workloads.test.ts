import { describe, expect, it } from "vitest";
import { authentikEnv, loginRedirectRoute, TRUSTED_PROXY_CIDRS } from "../src/authentik/workloads.js";
import { directusEnv } from "../src/crm/workloads.js";
import { clubspotFakeEnv } from "../src/clubspot-sync/fake.js";
import { databaseSecretName } from "../src/cluster.js";

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

  it("trusts the load balancer's proxies", () => {
    expect(TRUSTED_PROXY_CIDRS.split(",")).toEqual(expect.arrayContaining(["35.191.0.0/16", "130.211.0.0/22"]));
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
      }),
    );

    expect(env).toMatchObject({
      PUBLIC_URL: "https://directus.dev.example.com",
      AUTH_AUTHENTIK_ISSUER_URL: "https://login.dev.example.com/application/o/directus/",
      AUTH_AUTHENTIK_DEFAULT_ROLE_ID: "r",
      CORS_ORIGIN: "https://dev.example.com",
      AUTH_AUTHENTIK_REDIRECT_ALLOW_LIST: "https://dev.example.com",
      DB_HOST: "10.0.0.5",
    });
  });
});

describe("clubspotFakeEnv", () => {
  it("builds the database URI from the password variable before it", () => {
    const env = clubspotFakeEnv("10.0.0.5", "clubspot-fake-db");

    expect(env[0]).toMatchObject({ name: "DB_PASSWORD" });
    expect(env[1]).toEqual({
      name: "PARSE_SERVER_DATABASE_URI",
      value: "postgres://clubspot_fake:$(DB_PASSWORD)@10.0.0.5:5432/clubspot_fake",
    });
  });
});

describe("databaseSecretName", () => {
  it("replaces underscores, which Kubernetes names can't hold", () => {
    expect(databaseSecretName("clubspot_fake")).toBe("clubspot-fake-db");
  });
});

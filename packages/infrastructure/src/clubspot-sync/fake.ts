import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/**
 * The Clubspot fake's env: its database URI, from the database's Secret. Parse's pool defaults to
 * 10, which dev's db-f1-micro can't spare beside Authentik and Directus.
 */
export function clubspotFakeEnv(dbSecretName: pulumi.Input<string>): EnvVar[] {
  return [
    { name: "DATABASE_URI", valueFrom: { secretKeyRef: { name: dbSecretName, key: "uri" } } },
    { name: "PARSE_SERVER_DATABASE_URI", value: "$(DATABASE_URI)?max=2" },
  ];
}

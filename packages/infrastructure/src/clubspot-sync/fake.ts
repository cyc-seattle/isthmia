import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/**
 * The Clubspot fake's env. Kubernetes expands `$(DB_PASSWORD)` from the variable before it, so the
 * password stays in its Secret. It has only letters and digits, so it needs no escaping.
 */
export function clubspotFakeEnv(dbHost: string, dbSecretName: pulumi.Input<string>): EnvVar[] {
  return [
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: dbSecretName, key: "password" } } },
    {
      name: "PARSE_SERVER_DATABASE_URI",
      value: `postgres://clubspot_fake:$(DB_PASSWORD)@${dbHost}:5432/clubspot_fake`,
    },
  ];
}

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/**
 * The fake's database URI. Parse's pool defaults to 10, which dev's db-f1-micro can't spare beside
 * Authentik and Directus.
 */
export function clubspotFakeDatabaseUri(uri: string): string {
  return `${uri}?max=2`;
}

/** The Clubspot fake's env: its database URI, from the `uri` of `secretName`. */
export function clubspotFakeEnv(secretName: pulumi.Input<string>): EnvVar[] {
  return [{ name: "PARSE_SERVER_DATABASE_URI", valueFrom: { secretKeyRef: { name: secretName, key: "uri" } } }];
}

import { execFileSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as docker from "@pulumi/docker-build";
import * as random from "@pulumi/random";
import { clusterProvider, readPlatformOutputs, type PlatformOutputs } from "@cyc-seattle/platform";

// What every project that runs on the cluster shares (#231). A project builds its workloads only
// when its stack sets `<project>:onCluster`, so a prod stack stays on the VM until its move.

/** Whether this project's stack runs its workloads on the cluster. */
export function onCluster(): boolean {
  return new pulumi.Config().getBoolean("onCluster") ?? false;
}

/** Mailpit and the fakes exist only in dev. */
export const isDev = pulumi.getStack() === "dev";

export interface Cluster {
  /** Plain values, so a hostname under the domain can be a plain string, as `WebService` takes. */
  platform: PlatformOutputs;
  provider: k8s.Provider;
}

let cluster: Promise<Cluster> | undefined;

/** The environment's platform values and cluster provider. Lazy, so an off-cluster stack never reads them. */
export function loadCluster(): Promise<Cluster> {
  cluster ??= readPlatformOutputs().then((platform) => ({ platform, provider: clusterProvider(platform) }));
  return cluster;
}

/** Another isthmia project's stack in this environment. */
export function siblingStack(project: string): pulumi.StackReference {
  return new pulumi.StackReference(`organization/${project}/${pulumi.getStack()}`);
}

/** A Kubernetes Secret in the environment's namespace. */
export function appSecret(
  { platform, provider }: Cluster,
  name: string,
  stringData: Record<string, pulumi.Input<string>>,
  opts?: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  return new k8s.core.v1.Secret(
    name,
    { metadata: { name, namespace: platform.namespace }, stringData },
    { ...opts, provider },
  );
}

/** An env var read from a key of a Secret. */
export function secretEnv(name: string, secret: k8s.core.v1.Secret, key: string): k8s.types.input.core.v1.EnvVar {
  return { name, valueFrom: { secretKeyRef: { name: secret.metadata.name, key } } };
}

export interface AppDatabase {
  /** The database's name, which is also its user's. */
  name: string;
  /** Holds `host`, `database`, `username`, and `password`. `mise run db-shell` reads it. */
  secret: k8s.core.v1.Secret;
  host: string;
}

/** The Secret `mise run db-shell <database>` reads. Kubernetes names can't hold `_`. */
export function databaseSecretName(database: string): string {
  return `${database.replace(/_/g, "-")}-db`;
}

/**
 * A database and its user on the environment's Cloud SQL instance, through the Admin API, so no
 * deploy needs a route to the private IP. Users the API creates belong to `cloudsqlsuperuser`, which
 * owns the databases it creates, so the app can create its tables. Both outlive `pulumi destroy`:
 * Directus's license activation is tied to its database (#172).
 */
export function appDatabase(cluster: Cluster, name: string): AppDatabase {
  const { project, sqlConnectionName, sqlHost: host } = cluster.platform;
  const instance = sqlConnectionName.split(":")[2] ?? sqlConnectionName;
  // Letters and digits only, so the password can go into a connection URI unescaped.
  const password = new random.RandomPassword(`${name}-db-password`, { length: 32, special: false });
  const user = new gcp.sql.User(`${name}-db-user`, {
    project,
    instance,
    name,
    password: password.result,
    deletionPolicy: "ABANDON",
  });
  new gcp.sql.Database(`${name}-db`, { project, instance, name, deletionPolicy: "ABANDON" }, { dependsOn: user });
  const secret = appSecret(cluster, databaseSecretName(name), {
    host,
    database: name,
    username: name,
    password: password.result,
  });
  return { name, secret, host };
}

/** The commit being deployed. Images are tagged with it. */
export function commitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
}

export interface AppImageArgs {
  /** The build context, relative to the project's directory. */
  context: string;
  /** The Dockerfile, relative to the project's directory. Defaults to the context's `Dockerfile`. */
  dockerfile?: string;
  target?: string;
}

/**
 * An image built from this commit and pushed to the environment's registry, tagged with the commit
 * SHA. `ref` pins the digest. The push authenticates with the running credentials' access token.
 */
export function appImage({ platform }: Cluster, name: string, args: AppImageArgs): docker.Image {
  return new docker.Image(name, {
    tags: [`${platform.registry}/${name}:${commitSha()}`],
    context: { location: args.context },
    ...(args.dockerfile !== undefined && { dockerfile: { location: args.dockerfile } }),
    ...(args.target !== undefined && { target: args.target }),
    platforms: ["linux/amd64"],
    push: true,
    // Defaults to true: every preview would otherwise build the image (#114).
    buildOnPreview: false,
    registries: [
      {
        address: platform.registry.split("/")[0] ?? platform.registry,
        username: "oauth2accesstoken",
        password: gcp.organizations.getClientConfigOutput({}).accessToken,
      },
    ],
  });
}

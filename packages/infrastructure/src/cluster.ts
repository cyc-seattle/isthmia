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

const siblings = new Map<string, pulumi.StackReference>();

/**
 * A secret output of another isthmia project's stack in this environment. A preview tolerates it
 * missing, since the project before this one may not have deployed yet; an update requires it.
 */
export function siblingSecret(project: string, output: string): pulumi.Output<string> {
  let stack = siblings.get(project);
  if (!stack) {
    stack = new pulumi.StackReference(`organization/${project}/${pulumi.getStack()}`);
    siblings.set(project, stack);
  }
  const value = pulumi.runtime.isDryRun() ? stack.getOutput(output) : stack.requireOutput(output);
  return pulumi.secret(value.apply((v: string | undefined) => v ?? "")) as pulumi.Output<string>;
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
  /**
   * Holds `host`, `database`, `username`, `password`, and `uri`, a connection URI with the password
   * escaped. `mise run db-shell` reads it.
   */
  secret: k8s.core.v1.Secret;
  host: string;
  /** The secret's `uri`. */
  uri: pulumi.Output<string>;
}

/** The Secret `mise run db-shell <database>` reads. Kubernetes names can't hold `_`. */
export function databaseSecretName(database: string): string {
  return `${database.replace(/_/g, "-")}-db`;
}

/** A Postgres connection URI, with the password escaped. */
export function databaseUri(host: string, name: string, password: string): string {
  return `postgres://${name}:${encodeURIComponent(password)}@${host}:5432/${name}`;
}

/**
 * A database and its user, both `name`, on the environment's Cloud SQL instance. In dev, platform
 * creates them and keeps the password in Secret Manager: Cloud SQL ignores IAM conditions on user
 * and database calls, so deploy-dev can't make them (#231). Elsewhere this project creates them
 * through the Admin API, so no deploy needs a route to the private IP. Users the API creates belong
 * to `cloudsqlsuperuser`, which owns the databases it creates, so the app can create its tables.
 * Both outlive `pulumi destroy`: Directus's license activation is tied to its database (#172). With
 * `existingPassword`, the database and user exist already, and this writes only the Secret.
 */
export function appDatabase(cluster: Cluster, name: string, existingPassword?: pulumi.Output<string>): AppDatabase {
  const { project, sqlConnectionName, sqlHost: host } = cluster.platform;
  let password: pulumi.Output<string>;
  if (existingPassword) {
    // Prod's databases came from the VM, and its project's state already holds them (../vm.ts).
    password = existingPassword;
  } else if (isDev) {
    password = gcp.secretmanager
      .getSecretVersionAccessOutput({ secret: `dev-db-${name}-password` })
      .apply((version) => version.secretData);
  } else {
    const instance = sqlConnectionName.split(":")[2] ?? sqlConnectionName;
    password = new random.RandomPassword(`${name}-db-password`, { length: 32, special: false }).result;
    const user = new gcp.sql.User(`${name}-db-user`, { project, instance, name, password, deletionPolicy: "ABANDON" });
    new gcp.sql.Database(`${name}-db`, { project, instance, name, deletionPolicy: "ABANDON" }, { dependsOn: user });
  }
  const uri = pulumi.secret(password.apply((value) => databaseUri(host, name, value)));
  const secret = appSecret(cluster, databaseSecretName(name), {
    host,
    database: name,
    username: name,
    password: pulumi.secret(password),
    uri,
  });
  return { name, secret, host, uri };
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

/**
 * The image `appImage` builds, by digest. Dev builds and pushes it. Elsewhere it's looked up by the
 * commit's tag, so prod runs what dev ran (#231).
 */
export function deployedImage(cluster: Cluster, name: string, args: AppImageArgs): pulumi.Output<string> {
  if (isDev) {
    return appImage(cluster, name, args).ref;
  }
  const { registry } = cluster.platform;
  const [host = "", project = "", repositoryId = ""] = registry.split("/");
  const sha = commitSha();
  const image = gcp.artifactregistry
    .getDockerImage({
      location: host.replace(/-docker\.pkg\.dev$/, ""),
      project,
      repositoryId,
      imageName: `${name}:${sha}`,
    })
    .catch((error: unknown) => {
      throw new Error(
        `Can't find ${registry}/${name}:${sha}. Dev builds it: deploy this commit to dev first. (${String(error)})`,
      );
    });
  return pulumi.output(image).apply((found) => found.selfLink);
}

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { GoogleAuth } from "google-auth-library";
import { login } from "../../packages/infrastructure/src/directus/client";

// What the integration features share: dev's cluster, reached through the Kubernetes API as whatever
// identity ADC holds (deploy-dev in Actions), and dev's Directus. Playwright loads it too, so it
// mustn't import vitest.

/** Names a scenario's data, so runs never read or break each other's. Lowercase, for emails and Kubernetes names. */
export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}

/** fetch, typed by hand: without the DOM lib, @types/node leaves its Response empty. */
export const http = fetch as unknown as (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function accessToken(): Promise<string> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error("Application Default Credentials gave no access token.");
  }
  return token;
}

/** The fields of platform's outputs file that the features use. */
export interface DevPlatform {
  clusterEndpoint: string;
  namespace: string;
  domain: string;
}

let platform: Promise<DevPlatform> | undefined;

/** Reads dev's outputs file from its state bucket, the way the Pulumi projects do. */
export function devPlatform(): Promise<DevPlatform> {
  platform ??= (async () => {
    const project = process.env["GCP_PROJECT"];
    if (!project) {
      throw new Error("GCP_PROJECT isn't set. Run the tests under mise.");
    }
    const bucket = `${project}-pulumi-dev`;
    const object = encodeURIComponent("platform/outputs.json");
    const response = await http(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) {
      throw new Error(`Can't read gs://${bucket}/platform/outputs.json: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as DevPlatform;
  })();
  return platform;
}

export interface KubeResponse {
  status: number;
  body: any;
}

/** Calls dev's cluster API through its DNS-based endpoint, with the caller's Google token. */
export async function kube(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const { clusterEndpoint } = await devPlatform();
  const response = await http(`https://${clusterEndpoint}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  // A proxied service may answer with anything.
  const json = response.headers.get("content-type")?.startsWith("application/json");
  return { status: response.status, body: json && text ? JSON.parse(text) : text || undefined } as KubeResponse;
}

/** A path in dev's namespace, such as `/apis/batch/v1/namespaces/dev/jobs`. */
export async function namespaced(group: string, resource: string): Promise<string> {
  const { namespace } = await devPlatform();
  return `${group === "" ? "/api/v1" : `/apis/${group}`}/namespaces/${namespace}/${resource}`;
}

/** Calls a dev Service that isn't on the Gateway, through the API's service proxy. */
export async function proxy(
  service: string,
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return kube(method, `${await namespaced("", "services")}/${service}:${port}/proxy${path}`, body, headers);
}

/** Like `proxy`, but fails on anything but a 2xx. */
export async function proxyOk(...args: Parameters<typeof proxy>) {
  const [service, port, method, path] = args;
  const response = await proxy(...args);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${service}:${port}${path}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** One key of a Secret in dev's namespace. */
export async function secretValue(name: string, key: string): Promise<string> {
  const response = await kube("GET", `${await namespaced("", "secrets")}/${name}`);
  const value = response.body?.data?.[key];
  if (response.status !== 200 || typeof value !== "string") {
    throw new Error(`Can't read ${key} from the Secret ${name}: ${response.status}`);
  }
  return Buffer.from(value, "base64").toString("utf8");
}

/** The value of an env var that a Deployment's first container sets directly, if it sets one. */
export async function deploymentEnv(deployment: string, name: string): Promise<string | undefined> {
  const response = await kube("GET", `${await namespaced("apps/v1", "deployments")}/${deployment}`);
  if (response.status !== 200) {
    throw new Error(`Can't read the Deployment ${deployment}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const env: { name: string; value?: string }[] = response.body.spec.template.spec.containers[0].env ?? [];
  return env.find((variable) => variable.name === name)?.value;
}

/** Like `deploymentEnv`, for a variable the Deployment must set. */
export async function requiredDeploymentEnv(deployment: string, name: string): Promise<string> {
  const value = await deploymentEnv(deployment, name);
  if (value === undefined) {
    throw new Error(`The Deployment ${deployment} doesn't set ${name}.`);
  }
  return value;
}

/** The last lines of each pod's log that a Job ran, for a failure message. */
async function jobLogs(job: string): Promise<string> {
  const pods = await kube("GET", `${await namespaced("", "pods")}?labelSelector=job-name%3D${job}`);
  const logs = [];
  for (const pod of pods.body?.items ?? []) {
    const log = await kube("GET", `${await namespaced("", "pods")}/${pod.metadata.name}/log?tailLines=40`);
    logs.push(`--- ${pod.metadata.name}\n${log.body}`);
  }
  return logs.join("\n");
}

function jobFinished(job: any): boolean {
  const conditions: { type: string; status: string }[] = job.status?.conditions ?? [];
  return conditions.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True");
}

/** Whether a Job the CronJob owns, scheduled or manual, hasn't finished. */
async function cronJobRunning(jobs: string, cronUid: string): Promise<boolean> {
  const list = await kube("GET", jobs);
  if (list.status !== 200) {
    throw new Error(`Can't list Jobs: ${list.status} ${JSON.stringify(list.body)}`);
  }
  return (list.body.items ?? []).some(
    (job: any) => !jobFinished(job) && (job.metadata.ownerReferences ?? []).some((ref: any) => ref.uid === cronUid),
  );
}

// Longer than a sync Job takes, from creation to finishing.
const SCHEDULE_CLEARANCE_MS = 5 * 60_000;

/** Whether the CronJob fires within the clearance from now, or fired in the last minute. */
function nearSchedule(spec: { schedule: string; timeZone?: string }, now = new Date()): boolean {
  const next = new Cron(spec.schedule, { timezone: spec.timeZone ?? "UTC" }).nextRun(new Date(now.getTime() - 60_000));
  return next !== null && next.getTime() < now.getTime() + SCHEDULE_CLEARANCE_MS;
}

/** Runs a CronJob once, as `kubectl create job --from=cronjob/<name>` does, clear of its scheduled runs, and waits for it. */
export async function runCronJob(cronJob: string, runId: string, timeoutMs = 20 * 60_000): Promise<void> {
  const cron = await kube("GET", `${await namespaced("batch/v1", "cronjobs")}/${cronJob}`);
  if (cron.status !== 200) {
    throw new Error(`Can't read the CronJob ${cronJob}: ${cron.status} ${JSON.stringify(cron.body)}`);
  }
  const name = `${cronJob}-${runId}`;
  const jobs = await namespaced("batch/v1", "jobs");
  const deadline = Date.now() + timeoutMs;

  // The queue allows one worker at a time, so a second would fail the run (#251). Forbid counts only
  // the Jobs the CronJob scheduled, so it never holds off the schedule for this one.
  while (nearSchedule(cron.body.spec) || (await cronJobRunning(jobs, cron.body.metadata.uid))) {
    if (Date.now() > deadline) {
      throw new Error(`The CronJob ${cronJob} was still running a Job after ${timeoutMs / 60_000} minutes.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  const created = await kube("POST", jobs, {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      annotations: { "cronjob.kubernetes.io/instantiate": "manual" },
      labels: cron.body.spec.jobTemplate.metadata?.labels,
      // Owned like a scheduled run, so a later run of this helper waits for it too.
      ownerReferences: [
        { apiVersion: "batch/v1", kind: "CronJob", name: cronJob, uid: cron.body.metadata.uid, controller: true },
      ],
    },
    spec: { ...cron.body.spec.jobTemplate.spec, ttlSecondsAfterFinished: 3600 },
  });
  if (created.status !== 201) {
    throw new Error(`Can't create the Job ${name}: ${created.status} ${JSON.stringify(created.body)}`);
  }

  while (Date.now() < deadline) {
    const job = await kube("GET", `${jobs}/${name}`);
    const conditions: { type: string; status: string; message?: string }[] = job.body?.status?.conditions ?? [];
    if (conditions.some((c) => c.type === "Complete" && c.status === "True")) {
      return;
    }
    const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
    if (failed) {
      throw new Error(`The Job ${name} failed: ${failed.message}\n${await jobLogs(name)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`The Job ${name} didn't finish in ${timeoutMs / 60_000} minutes.\n${await jobLogs(name)}`);
}

export interface DirectusAdmin {
  baseUrl: string;
  token: string;
}

let admin: Promise<DirectusAdmin> | undefined;

/**
 * Signs in to dev's Directus as its built-in admin, with the password `crm` wrote to the `directus`
 * Secret. The deploy already holds it, so no test token needs creating or rotating.
 */
export function directusAdmin(): Promise<DirectusAdmin> {
  admin ??= (async () => {
    const baseUrl = `https://directus.${(await devPlatform()).domain}`;
    const email = await requiredDeploymentEnv("directus", "ADMIN_EMAIL");
    const password = await secretValue("directus", "ADMIN_PASSWORD");
    return { baseUrl, token: await login(baseUrl, email, password) };
  })();
  return admin;
}

/** A Directus REST call that doesn't throw on an error status, since several are expected. */
export async function directus(token: string, method: string, path: string, body?: unknown) {
  const { baseUrl } = await directusAdmin();
  const send = () =>
    http(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  let response = await send();
  // Dev's small Directus sheds load with a 503 ("Under pressure") during the fixtures' burst.
  for (let attempt = 1; response.status === 503 && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    response = await send();
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined } as KubeResponse;
}

/** A Directus REST call as the admin, which must succeed. Returns the response's `data`. */
export async function asAdmin(method: string, path: string, body?: unknown): Promise<any> {
  const { token } = await directusAdmin();
  const response = await directus(token, method, path, body);
  if (response.status >= 300) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body?.data;
}

/**
 * Whether dev's Directus runs with a license, from `crm`'s dev stack config. Without one, Directus
 * applies no relational permission rules, so `@licensed` features can't pass (#172).
 */
export function devDirectusLicensed(): boolean {
  const config = readFileSync(join(__dirname, "../../packages/infrastructure/src/crm/Pulumi.dev.yaml"), "utf8");
  return !/^\s*crm:licensed:\s*false\s*$/m.test(config);
}

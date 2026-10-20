import * as pulumi from "@pulumi/pulumi";
import { httpFetch } from "../directus/client";

// The embedded outpost's ID differs per instance, and Pulumi's `import` needs it before the program
// runs. This finds the outpost by its `managed` key at apply time instead, so a fresh instance needs
// no second, hand-fed deploy. Prod still imports it by ID (`authentik:embeddedOutpostId`).

export const EMBEDDED_OUTPOST_MANAGED = "goauthentik.io/outposts/embedded";

interface Outpost {
  pk: string;
  managed: string | null;
}

async function authentikRequest<T>(url: string, token: string, method: string, path: string, body?: unknown) {
  const response = await httpFetch(`${url}/api/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`Authentik ${method} ${path} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** The embedded outpost's pk, from the first page of outposts. An instance has only a few. */
export async function findEmbeddedOutpost(url: string, token: string): Promise<string> {
  const page = await authentikRequest<{ results: Outpost[] }>(url, token, "GET", "/outposts/instances/?page_size=100");
  const outpost = page.results.find((candidate) => candidate.managed === EMBEDDED_OUTPOST_MANAGED);
  if (!outpost) {
    throw new Error(`Authentik at ${url} has no outpost managed as ${EMBEDDED_OUTPOST_MANAGED}.`);
  }
  return outpost.pk;
}

interface EmbeddedOutpostInputs {
  url: string;
  token: string;
  providers: number[];
  /** `embeddedOutpostConfig`'s JSON. */
  config: string;
}

async function reconcile(inputs: EmbeddedOutpostInputs): Promise<string> {
  const id = await findEmbeddedOutpost(inputs.url, inputs.token);
  await authentikRequest(inputs.url, inputs.token, "PATCH", `/outposts/instances/${id}/`, {
    providers: inputs.providers,
    config: JSON.parse(inputs.config),
  });
  return id;
}

export const embeddedOutpostProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: EmbeddedOutpostInputs) {
    const id = await reconcile(inputs);
    return { id, outs: inputs };
  },
  async update(_id: string, _olds: EmbeddedOutpostInputs, news: EmbeddedOutpostInputs) {
    await reconcile(news);
    return { outs: news };
  },
  // Authentik owns the outpost; it outlives this resource.
  async delete() {},
};

export interface EmbeddedOutpostArgs {
  url: pulumi.Input<string>;
  token: pulumi.Input<string>;
  providers: pulumi.Input<pulumi.Input<number>[]>;
  config: pulumi.Input<string>;
}

/** Sets the embedded outpost's providers and config, wherever the instance put it. */
export class EmbeddedOutpost extends pulumi.dynamic.Resource {
  constructor(name: string, args: EmbeddedOutpostArgs, opts?: pulumi.CustomResourceOptions) {
    super(embeddedOutpostProvider, name, { ...args }, { ...opts, additionalSecretOutputs: ["token"] });
  }
}

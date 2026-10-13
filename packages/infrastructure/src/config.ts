import * as pulumi from "@pulumi/pulumi";

// Cross-cutting values used across the package. Configuration used by only one file lives in that
// file (e.g. domains in dns.ts, the VM machine type in compute.ts).

const gcpConfig = new pulumi.Config("gcp");

export const location = gcpConfig.require("region");

export const projectId = gcpConfig.require("project");

/** Checks that a list-valued config key holds a non-empty list of non-empty strings. */
export function parseStringList(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Config "${key}" must be a non-empty list of strings.`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      throw new Error(`Config "${key}" must be a non-empty list of strings, but holds ${JSON.stringify(item)}.`);
    }
  }
  return value;
}

/** Reads a required list of strings from this project's stack config. */
export function requireStringList(key: string): string[] {
  return parseStringList(key, new pulumi.Config().requireObject<unknown>(key));
}

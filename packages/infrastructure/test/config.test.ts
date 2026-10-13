import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

let config: typeof import("../src/config.js");

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => ({ id: `${args.name}_id`, state: args.inputs }),
      call: (args) => args.inputs,
    },
    "example",
  );
  pulumi.runtime.setConfig("gcp:project", "example-project");
  pulumi.runtime.setConfig("gcp:region", "us-west1");
  pulumi.runtime.setConfig("example:admins", JSON.stringify(["a@example.com", "b@example.com"]));
  pulumi.runtime.setConfig("example:empty", "[]");
  // The module reads gcp config on import, so it loads only after the config is set.
  config = await import("../src/config.js");
});

describe("location and projectId", () => {
  it("come from the gcp config", () => {
    expect(config.location).toBe("us-west1");
    expect(config.projectId).toBe("example-project");
  });
});

describe("parseStringList", () => {
  it("returns a list of strings unchanged", () => {
    expect(config.parseStringList("key", ["user:a@example.com"])).toEqual(["user:a@example.com"]);
  });

  it.each([
    { label: "a string", value: "user:a@example.com" },
    { label: "an object", value: { member: "user:a@example.com" } },
    { label: "an empty list", value: [] },
    { label: "a list with a number", value: ["user:a@example.com", 1] },
    { label: "a list with an empty string", value: [""] },
  ])("rejects $label", ({ value }: { value: unknown }) => {
    expect(() => config.parseStringList("key", value)).toThrow(/Config "key"/);
  });
});

describe("requireStringList", () => {
  it("reads the key from the project's namespace", () => {
    expect(config.requireStringList("admins")).toEqual(["a@example.com", "b@example.com"]);
  });

  it("fails on a missing key", () => {
    expect(() => config.requireStringList("missing")).toThrow(/example:missing/);
  });

  it("fails on an empty list", () => {
    expect(() => config.requireStringList("empty")).toThrow(/Config "empty"/);
  });
});

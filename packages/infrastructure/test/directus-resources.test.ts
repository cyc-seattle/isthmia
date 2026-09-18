import { describe, it, expect } from "vitest";
import { omitUndefined } from "../src/directus/resources.js";
import { describeProviderError, DirectusHttpError } from "../src/directus/client.js";

describe("omitUndefined", () => {
  it("drops keys whose value is undefined", () => {
    expect(omitUndefined({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
  });

  it("keeps null and falsy-but-defined values", () => {
    expect(omitUndefined({ a: null, b: false, c: 0, d: "" })).toEqual({ a: null, b: false, c: 0, d: "" });
  });

  it("leaves an object with no undefined values unchanged", () => {
    const obj = { a: 1, b: "x" };
    expect(omitUndefined(obj)).toEqual(obj);
  });
});

describe("describeProviderError", () => {
  it("carries a plain Error's message, tagged with the resource and method", () => {
    const result = describeProviderError("DirectusRole", "create", new Error("boom"));
    expect(result.message).toContain("DirectusRole.create");
    expect(result.message).toContain("boom");
  });

  it("carries a DirectusHttpError's message and status", () => {
    const result = describeProviderError("DirectusUser", "update", new DirectusHttpError(404, "not found"));
    expect(result.message).toContain("not found");
    expect(result.message).toContain("404");
  });

  it("falls back to String(error) for an object with no message", () => {
    const result = describeProviderError("DirectusPermissionRule", "diff", { foo: "bar" });
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("DirectusPermissionRule.diff");
  });

  it("falls back to String(error) for a thrown undefined — the case that was previously invisible", () => {
    const result = describeProviderError("DirectusAdminAccessGrant", "delete", undefined);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("DirectusAdminAccessGrant.delete");
  });
});

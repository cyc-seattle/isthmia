import { describe, it, expect } from "vitest";
import { omitUndefined } from "../src/directus/resources.js";

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

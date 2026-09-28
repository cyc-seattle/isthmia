import { describe, expect, it } from "vitest";
import { planGroupDiff } from "../src/group-diff.js";

describe("planGroupDiff", () => {
  it("adds a target email missing from the current members", () => {
    const diff = planGroupDiff(["a@example.com"], ["a@example.com", "b@example.com"]);

    expect(diff).toEqual({ toAdd: ["b@example.com"], toRemove: [] });
  });

  it("removes a current member no longer in the target set", () => {
    const diff = planGroupDiff(["a@example.com", "b@example.com"], ["a@example.com"]);

    expect(diff).toEqual({ toAdd: [], toRemove: ["b@example.com"] });
  });

  it("computes both an add and a remove in the same diff", () => {
    const diff = planGroupDiff(["a@example.com", "stale@example.com"], ["a@example.com", "new@example.com"]);

    expect(diff).toEqual({ toAdd: ["new@example.com"], toRemove: ["stale@example.com"] });
  });

  it("normalizes case and whitespace before comparing", () => {
    const diff = planGroupDiff(["  A@Example.com "], ["a@example.com"]);

    expect(diff).toEqual({ toAdd: [], toRemove: [] });
  });

  it("reports no changes when current already matches target", () => {
    const diff = planGroupDiff(["a@example.com"], ["a@example.com"]);

    expect(diff).toEqual({ toAdd: [], toRemove: [] });
  });
});

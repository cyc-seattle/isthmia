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

  it("throws when the target is empty but the group currently has members", () => {
    expect(() => planGroupDiff(["a@example.com", "b@example.com"], [])).toThrow(/refusing to remove them all/);
  });

  it("throws when more than half of the current members would be removed", () => {
    const current = ["a@example.com", "b@example.com", "c@example.com"];

    expect(() => planGroupDiff(current, ["a@example.com"])).toThrow(/more than.*half/);
  });

  it("allows removing exactly half of the current members", () => {
    const diff = planGroupDiff(["a@example.com", "b@example.com"], ["a@example.com"]);

    expect(diff).toEqual({ toAdd: [], toRemove: ["b@example.com"] });
  });

  it("allows a large removal when allowLargeRemoval is set", () => {
    const diff = planGroupDiff(["a@example.com", "b@example.com", "c@example.com"], [], {
      allowLargeRemoval: true,
    });

    expect(diff).toEqual({ toAdd: [], toRemove: ["a@example.com", "b@example.com", "c@example.com"] });
  });
});

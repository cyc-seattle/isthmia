import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP_OWNERS, planGroupOwners } from "../src/owners.js";

describe("planGroupOwners", () => {
  it("comes from the given config list, not any CRM row", () => {
    expect(planGroupOwners(["master@cyccommunitysailing.org"])).toEqual(["master@cyccommunitysailing.org"]);
  });

  it("normalizes and dedupes a repeated address", () => {
    const result = planGroupOwners(["Master@CYCCommunitySailing.org", " master@cyccommunitysailing.org "]);

    expect(result).toEqual(["master@cyccommunitysailing.org"]);
  });

  it("defaults to master@ today", () => {
    expect(DEFAULT_GROUP_OWNERS).toEqual(["master@cyccommunitysailing.org"]);
  });
});

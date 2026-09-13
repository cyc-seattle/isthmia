import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/main.js";

describe("redactSecrets", () => {
  it("redacts the Clubspot password and the Directus token, keeping other options", () => {
    const opts = {
      username: "user@example.com",
      password: "hunter2",
      club: "club-1",
      directusUrl: "https://directus.example.com",
      directusToken: "super-secret-token",
      dryRun: false,
    };

    const redacted = redactSecrets(opts);

    expect(redacted).toMatchObject({
      username: "user@example.com",
      club: "club-1",
      directusUrl: "https://directus.example.com",
      dryRun: false,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("super-secret-token");
  });

  it("leaves options unchanged when no secret-bearing keys are present", () => {
    const opts = { club: "club-1" };

    expect(redactSecrets(opts)).toEqual({ club: "club-1" });
  });
});

import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/main.js";

describe("redactSecrets", () => {
  it("redacts the Clubspot password, keeping other options", () => {
    const opts = {
      username: "user@example.com",
      password: "hunter2",
      verbose: "info",
    };

    const redacted = redactSecrets(opts);

    expect(redacted).toMatchObject({ username: "user@example.com", verbose: "info" });
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("leaves options unchanged when no secret-bearing keys are present", () => {
    const opts = { username: "user@example.com" };

    expect(redactSecrets(opts)).toEqual({ username: "user@example.com" });
  });
});

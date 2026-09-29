import { describe, it, expect } from "vitest";
import { renderWelcomePage } from "../src/render.js";

describe("renderWelcomePage", () => {
  const html = renderWelcomePage();

  it("emits a complete HTML document titled for the org", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>CYC Community Sailing Center</title>");
  });

  it("links sign-in back to the portal root", () => {
    expect(html).toContain('<a href="/">Sign in</a>');
  });

  it("lists the contact address", () => {
    expect(html).toContain("info@cyccommunitysailing.org");
  });

  it("carries no Caddy template directives", () => {
    expect(html).not.toContain("{{");
    expect(html).not.toContain("}}");
  });

  it("has no staff-only or gated content", () => {
    expect(html).not.toContain("staffOnly");
    expect(html).not.toContain("X-Authentik-Groups");
  });
});

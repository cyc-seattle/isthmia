import { describe, it, expect } from "vitest";
import { renderPage, escapeHtml } from "../src/render.js";
import type { Section } from "../src/links.js";

const fixture: readonly Section[] = [
  {
    audience: "Staff",
    description: "Ops tools.",
    links: [{ title: "Reports", url: "https://example.com/reports", description: "The reports sheet." }],
  },
  {
    audience: "Volunteers",
    links: [{ title: "Sign up", url: "https://example.com/signup" }],
  },
];

describe("renderPage", () => {
  const html = renderPage(fixture);

  it("emits a complete HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>CYC Community Sailing — Team Links</title>");
  });

  it("renders a section per audience", () => {
    expect(html).toContain("<h2>Staff</h2>");
    expect(html).toContain("<h2>Volunteers</h2>");
  });

  it("renders each link with its href and title", () => {
    expect(html).toContain('<a href="https://example.com/reports">Reports</a>');
    expect(html).toContain('<a href="https://example.com/signup">Sign up</a>');
  });

  it("includes a link description when present and omits it otherwise", () => {
    expect(html).toContain("The reports sheet.");
    // The volunteers link has no description, so no stray empty description paragraph follows it.
    expect(html).not.toContain('<p class="link-desc"></p>');
  });
});

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
  });

  it("escapes untrusted content when rendered", () => {
    const html = renderPage([{ audience: "Q&A <b>", links: [{ title: "x", url: "https://e.test/?a=1&b=2" }] }]);
    expect(html).toContain("<h2>Q&amp;A &lt;b&gt;</h2>");
    expect(html).toContain('href="https://e.test/?a=1&amp;b=2"');
  });
});

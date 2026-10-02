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

describe("renderPage gating", () => {
  const gatedFixture: readonly Section[] = [
    { audience: "Everyone", links: [{ title: "Clubspot", url: "https://example.com/public" }] },
    { audience: "Staff", staffOnly: true, links: [{ title: "Admin reports", url: "https://example.com/reports" }] },
  ];
  const html = renderPage(gatedFixture);

  it("computes the visitor's groups once, from the pipe-separated header", () => {
    expect(html).toContain('{{$groups := splitList "|" (.Req.Header.Get "X-Authentik-Groups")}}');
  });

  it("renders a section with no staffOnly flag with no template condition around it", () => {
    expect(html).toContain("<h2>Everyone</h2>");
    expect(html).not.toContain('{{if has "staff" $groups}}\n    <section class="audience">\n      <h2>Everyone');
  });

  it("wraps a staffOnly section in a whole-name group check, matching Authentik's own group name", () => {
    const start = html.indexOf('{{if has "staff" $groups}}');
    const end = html.indexOf("{{end}}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // The gated link appears only inside its own {{if}}/{{end}} block — never unconditionally.
    expect(html.slice(start, end)).toContain("Admin reports");
    expect(html.slice(0, start)).not.toContain("Admin reports");
    expect(html.slice(end)).not.toContain("Admin reports");
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

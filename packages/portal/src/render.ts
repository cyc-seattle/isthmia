import type { Section } from "./links.js";

/** Escapes a string for safe interpolation into HTML text and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderLink(link: { title: string; url: string; description?: string }): string {
  const description = link.description ? `<p class="link-desc">${escapeHtml(link.description)}</p>` : "";
  return `        <li class="link">
          <a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a>
          ${description}
        </li>`;
}

function renderSection(section: Section): string {
  const description = section.description ? `      <p class="section-desc">${escapeHtml(section.description)}</p>` : "";
  const links = section.links.map(renderLink).join("\n");
  return `    <section class="audience">
      <h2>${escapeHtml(section.audience)}</h2>
${description}
      <ul class="links">
${links}
      </ul>
    </section>`;
}

/**
 * Renders the whole portal as a single self-contained HTML document (inline CSS, responsive,
 * light/dark aware). Pure function of the content — no I/O — so it is trivially testable.
 */
export function renderPage(sections: readonly Section[]): string {
  const body = sections.map(renderSection).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CYC Community Sailing — Team Links</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --fg: #1a1a1a;
        --muted: #5a5a5a;
        --card: #f4f6f8;
        --accent: #0b6bcb;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #14171a;
          --fg: #e8e8e8;
          --muted: #9aa0a6;
          --card: #1e2226;
          --accent: #4ea1ff;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--bg);
        color: var(--fg);
        line-height: 1.5;
      }
      main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
      header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
      header p { margin: 0 0 2rem; color: var(--muted); }
      .audience { margin-bottom: 2rem; }
      .audience h2 { margin: 0 0 0.25rem; font-size: 1.2rem; }
      .section-desc { margin: 0 0 0.75rem; color: var(--muted); }
      ul.links { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
      .link { background: var(--card); border-radius: 0.6rem; padding: 0.85rem 1rem; }
      .link a { color: var(--accent); font-weight: 600; text-decoration: none; }
      .link a:hover { text-decoration: underline; }
      .link-desc { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.92rem; }
      footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>CYC Community Sailing</h1>
        <p>Your starting point for the tools and resources the team uses.</p>
      </header>
${body}
      <footer>You are signed in with Google. Contact an admin if a link you need is missing.</footer>
    </main>
  </body>
</html>
`;
}

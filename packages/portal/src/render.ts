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

/** The Authentik group Caddy's `templates` handler checks a `staffOnly` section's visibility
 * against — must match `STAFF_GROUP_NAME` in `packages/infrastructure/src/authentik/naming.ts`.
 * Portal has no dependency on that package (it's a plain static site), so the name is repeated
 * here rather than imported. */
const STAFF_GROUP = "staff";

// Caddy's templates handler runs Go's text/template (with Sprig's function set), not html/template,
// over the served HTML — so this text becomes a live template action, not literal markup, and Caddy
// never escapes it. Every value plugged in here comes from links.ts's static config, never from a
// request; nothing user-controlled may reach a Caddy-templated page. See
// packages/substrate/deploy/Caddyfile's `templates` directive on the block this file is served
// from. `$groups` splits Authentik's `|`-separated header once, so every gated section compares
// against whole names, never a substring.
const GROUPS_ASSIGNMENT = `    {{$groups := splitList "|" (.Req.Header.Get "X-Authentik-Groups")}}`;

function renderGatedSection(section: Section): string {
  const body = renderSection(section);
  if (!section.staffOnly) return body;
  return `    {{if has "${STAFF_GROUP}" $groups}}\n${body}\n    {{end}}`;
}

/** Team rosters (#166) — fetched live from Directus by `roster/browser.js`, not a static link list,
 * so it's rendered here rather than as a `Section`. Every signed-in visitor reaches this page
 * already gated by Authentik, and Directus's own permission rules decide what each one actually
 * sees, so the section carries no `staffOnly`-style template condition of its own. */
function renderRosterSection(): string {
  return `    <section class="audience" id="roster">
      <h2>My Teams</h2>
      <div id="roster-root">
        <p class="roster-status">Loading your roster…</p>
      </div>
      <noscript><p>Enable JavaScript to see your team roster.</p></noscript>
    </section>
    <script type="module" src="/roster/browser.js"></script>`;
}

// Shared across renderPage and renderWelcomePage so the unauthenticated landing page looks like
// the same site, not a different one Authentik happened to bounce a visitor to.
const PAGE_STYLE = `
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
      .roster-filters { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0 0 1rem; }
      .roster-filter { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; color: var(--muted); }
      .roster-filter select { font: inherit; padding: 0.4rem; border-radius: 0.4rem; }
      .roster-toggle { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 1rem; }
      .roster-toggle input { width: 1.2rem; height: 1.2rem; }
      .roster-program { background: var(--card); border-radius: 0.6rem; padding: 0.6rem 0.85rem; margin-bottom: 0.75rem; }
      .roster-program summary { font-weight: 600; cursor: pointer; }
      ul.roster-members { list-style: none; margin: 0.75rem 0 0; padding: 0; display: grid; gap: 0.6rem; }
      .roster-member { padding: 0.5rem 0; border-top: 1px solid var(--bg); }
      .roster-member:first-child { border-top: none; padding-top: 0; }
      .roster-name { margin: 0; font-weight: 600; }
      .roster-school, .roster-contact { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.9rem; }
      .roster-empty, .roster-status, .roster-error { color: var(--muted); }
`;

/**
 * Renders the whole portal as a single self-contained HTML document (inline CSS, responsive,
 * light/dark aware), with each `staffOnly` section wrapped in the Caddy template condition above.
 * Pure function of the content — no I/O — so it is trivially testable.
 */
export function renderPage(sections: readonly Section[]): string {
  const body = [GROUPS_ASSIGNMENT, renderRosterSection(), ...sections.map(renderGatedSection)].join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CYC Community Sailing — Team Links</title>
    <style>${PAGE_STYLE}    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>CYC Community Sailing</h1>
        <p>Your starting point for the tools and resources the team uses.</p>
      </header>
${body}
      <footer>You are signed in. Contact an admin if a link you need is missing.</footer>
    </main>
  </body>
</html>
`;
}

/**
 * Renders the public, unauthenticated page Authentik's "Go home" button lands on after a denied
 * or ended sign-in (`/` and `/if/user/` on the login domain redirect here — see the substrate
 * Caddyfile). Served with no auth gate, so it must carry no Caddy `templates` directive and no
 * staff-only content: everything here is visible to any visitor, signed in or not.
 */
export function renderWelcomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CYC Community Sailing Center</title>
    <style>${PAGE_STYLE}    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>CYC Community Sailing Center</h1>
        <p>We run sailing programs and community events for Seattle families.</p>
      </header>
      <p><a href="/">Sign in</a> to reach the team portal.</p>
      <footer>Questions? Contact <a href="mailto:info@cyccommunitysailing.org">info@cyccommunitysailing.org</a>.</footer>
    </main>
  </body>
</html>
`;
}

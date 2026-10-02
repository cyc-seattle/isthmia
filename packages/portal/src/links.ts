/**
 * Portal content — the single source of truth for the links shown at cycsail.team.
 *
 * This is intentionally a plain, typed data file: editing links means editing this array and
 * redeploying the static site (there is no backend). Keep entries short and grouped by the audience
 * that needs them. Seeded with a skeleton — replace the placeholder URLs with real ones.
 */

export interface Link {
  readonly title: string;
  readonly url: string;
  readonly description?: string;
}

export interface Section {
  /** Audience or theme, e.g. "Everyone", "Staff", "Volunteers", "Instructors". */
  readonly audience: string;
  readonly description?: string;
  readonly links: readonly Link[];
  /**
   * Restricts this section to a visitor in Authentik's `staff` group (render.ts wraps it in a
   * Caddy `templates` condition on the `X-Authentik-Groups` header); omitted or false means every
   * signed-in visitor.
   */
  readonly staffOnly?: boolean;
}

export const sections: readonly Section[] = [
  {
    audience: "Everyone",
    description: "Shared tools everyone at CYC uses.",
    links: [
      { title: "Clubspot", url: "https://theclubspot.com", description: "Registrations, camps, and schedules." },
      { title: "Google Calendar", url: "https://calendar.google.com", description: "The CYC shared calendars." },
    ],
  },
  {
    audience: "Staff",
    description: "Day-to-day operations and admin.",
    staffOnly: true,
    links: [
      {
        title: "Admin reports",
        url: "https://example.com/reports",
        description: "Placeholder — link the reports sheet.",
      },
    ],
  },
  {
    audience: "Volunteers",
    description: "Getting started and signing up for shifts.",
    staffOnly: true,
    links: [
      {
        title: "Volunteer handbook",
        url: "https://example.com/handbook",
        description: "Placeholder — link the handbook.",
      },
    ],
  },
  {
    audience: "Instructors",
    description: "On-the-water resources and rosters.",
    staffOnly: true,
    links: [
      { title: "Session rosters", url: "https://example.com/rosters", description: "Placeholder — link the rosters." },
    ],
  },
];

// The roster itself isn't in `sections` above — it's not a static list of links, it's fetched live
// from Directus by `roster/browser.ts` and rendered client-side. `render.ts`'s `renderRosterSection`
// emits its container.

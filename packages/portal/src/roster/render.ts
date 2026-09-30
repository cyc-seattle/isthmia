/**
 * Pure HTML-string rendering for the roster section, in the same style as `../render.ts` — no DOM,
 * so it's tested the same way. `browser.ts` is the only impure piece: it fetches, calls these
 * functions, and assigns the result to an element's `innerHTML`.
 */
import type { FilterOption, ProgramGroup, RosterFilter, TeamMember } from "./model.js";

// Duplicated from ../render.ts rather than imported: tsconfig.client.json's `rootDir` is
// `src/roster`, so this whole browser-compiled tree can't reach outside it.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const ROSTER_HELP_TEXT =
  "If you can't see your team, sign in with the email you registered with in Clubspot, or write to " +
  "info@cyccommunitysailing.org.";

function renderMember(member: TeamMember): string {
  const contactLine = [member.email, member.phone].filter((value): value is string => !!value);
  const school = member.school ? `<p class="roster-school">${escapeHtml(member.school)}</p>` : "";
  const contact =
    contactLine.length > 0 ? `<p class="roster-contact">${contactLine.map(escapeHtml).join(" · ")}</p>` : "";
  return `          <li class="roster-member">
            <p class="roster-name">${escapeHtml(member.fullName)}</p>
${school}${contact}
          </li>`;
}

function renderProgramGroup(group: ProgramGroup, openByDefault: boolean): string {
  const members = group.members.map(renderMember).join("\n");
  return `        <details class="roster-program"${openByDefault ? " open" : ""}>
          <summary>${escapeHtml(group.programName)} (${group.members.length})</summary>
          <ul class="roster-members">
${members}
          </ul>
        </details>`;
}

/** Collapsed by default so a Staff viewer's full-org roster doesn't dump every program open at
 * once; a family with exactly one program gets it opened for them. */
export function renderRosterGroups(groups: readonly ProgramGroup[]): string {
  if (groups.length === 0) {
    return `      <p class="roster-empty">${escapeHtml(ROSTER_HELP_TEXT)}</p>`;
  }
  const openByDefault = groups.length === 1;
  return `      <div class="roster-groups">
${groups.map((group) => renderProgramGroup(group, openByDefault)).join("\n")}
      </div>`;
}

function renderOption(option: FilterOption, selected: string | null): string {
  const isSelected = option.value === selected ? " selected" : "";
  return `          <option value="${escapeHtml(option.value)}"${isSelected}>${escapeHtml(option.label)}</option>`;
}

function renderFilterSelect(id: string, label: string, options: readonly FilterOption[], selected: string | null) {
  const optionTags = options.map((option) => renderOption(option, selected)).join("\n");
  return `        <label class="roster-filter">
          ${escapeHtml(label)}
          <select id="${id}">
            <option value="">All</option>
${optionTags}
          </select>
        </label>`;
}

export function renderFilters(
  teams: readonly FilterOption[],
  schools: readonly FilterOption[],
  filter: RosterFilter,
): string {
  return `      <div class="roster-filters">
${renderFilterSelect("roster-team-filter", "Team", teams, filter.team)}
${renderFilterSelect("roster-school-filter", "School", schools, filter.school)}
      </div>`;
}

export function renderFamilyToggle(checked: boolean): string {
  return `      <label class="roster-toggle">
        <input type="checkbox" id="roster-share-toggle"${checked ? " checked" : ""} />
        Share my family's contact info with teammates
      </label>`;
}

export interface RosterViewState {
  readonly groups: readonly ProgramGroup[];
  readonly teams: readonly FilterOption[];
  readonly schools: readonly FilterOption[];
  readonly filter: RosterFilter;
  /** `null` when the `family` policy's read granted no rows — the toggle only ever appears for a
   * signed-in guardian or opted-in adult. */
  readonly family: { readonly checked: boolean } | null;
}

export function renderRoster(state: RosterViewState): string {
  const filters = state.teams.length > 0 ? renderFilters(state.teams, state.schools, state.filter) : "";
  const toggle = state.family ? renderFamilyToggle(state.family.checked) : "";
  return `${filters}
${toggle}
${renderRosterGroups(state.groups)}`;
}

export function renderRosterError(message: string): string {
  return `      <p class="roster-error">${escapeHtml(message)}</p>`;
}

/** Shown instead of `renderRosterError` when the redirect guard blocks a further attempt — the
 * link lets a visitor retry by hand once they've actually finished signing in. */
export function renderRosterBlocked(signInUrl: string): string {
  return (
    `      <p class="roster-error">Sign-in didn't complete. ` +
    `<a href="${escapeHtml(signInUrl)}">Sign in again</a>, or write to info@cyccommunitysailing.org.</p>`
  );
}

export function renderRosterLoading(): string {
  return `      <p class="roster-status">Loading your roster…</p>`;
}

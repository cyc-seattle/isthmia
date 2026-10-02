/**
 * Pure HTML-string rendering for the roster section, in the same style as `../render.ts` — no DOM,
 * so it's tested the same way. `browser.ts` is the only impure piece: it fetches, calls these
 * functions, and assigns the result to an element's `innerHTML`.
 */
import type { FilterOption, GuardianContact, ProgramGroup, RosterFilter, ShareToggleRow, TeamMember } from "./model.js";

// Duplicated from ../render.ts rather than imported: tsconfig.client.json's `rootDir` is
// `src/roster`, so this whole browser-compiled tree can't reach outside it.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const ROSTER_HELP_TEXT =
  "If you can't see your team, sign in with the email you registered with in Clubspot, or write to " +
  "info@cyccommunitysailing.org.";

function renderGuardianContact(contact: GuardianContact): string {
  const contactLine = [contact.email, contact.phone].filter((value): value is string => !!value);
  const details = contactLine.length > 0 ? `: ${contactLine.map(escapeHtml).join(" · ")}` : "";
  return `<p class="roster-contact">${escapeHtml(contact.fullName)}${details}</p>`;
}

function renderMember(member: TeamMember): string {
  const contactLine = [member.email, member.phone].filter((value): value is string => !!value);
  const school = member.school ? `<p class="roster-school">${escapeHtml(member.school)}</p>` : "";
  const contact =
    contactLine.length > 0 ? `<p class="roster-contact">${contactLine.map(escapeHtml).join(" · ")}</p>` : "";
  const guardianContacts = member.guardianContacts.map(renderGuardianContact).join("\n");
  return `          <li class="roster-member">
            <p class="roster-name">${escapeHtml(member.fullName)}</p>
${school}${contact}${guardianContacts}
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

function renderShareToggle(row: ShareToggleRow): string {
  return `        <label class="roster-toggle">
          <input type="checkbox" class="roster-share-toggle" data-registration-id="${escapeHtml(row.registrationId)}"${row.checked ? " checked" : ""} />
          Share ${escapeHtml(row.firstName)}'s contact info for ${escapeHtml(row.campName)}
        </label>`;
}

/** No section at all when the viewer has nothing writable this season. */
export function renderShareToggles(rows: readonly ShareToggleRow[]): string {
  if (rows.length === 0) return "";
  return `      <div class="roster-share-toggles">
${rows.map(renderShareToggle).join("\n")}
      </div>`;
}

export interface RosterViewState {
  readonly groups: readonly ProgramGroup[];
  readonly teams: readonly FilterOption[];
  readonly schools: readonly FilterOption[];
  readonly filter: RosterFilter;
  readonly shareToggles: readonly ShareToggleRow[];
}

export function renderRoster(state: RosterViewState): string {
  const filters = state.teams.length > 0 ? renderFilters(state.teams, state.schools, state.filter) : "";
  return `${filters}
${renderShareToggles(state.shareToggles)}
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

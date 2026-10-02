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

export interface VCardContact {
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/** Escapes vCard 3.0's text-value special characters (RFC 6350 §3.4): a backslash, then the
 * characters it would otherwise be mistaken for, so the order matters. */
function escapeVCardText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

/** The model only carries a combined `fullName`, not separate given/family names, so the vCard's
 * `N` property approximates them by splitting on the last space - right for the common case, not
 * exact for every name. */
function splitName(fullName: string): { given: string; family: string } {
  const trimmed = fullName.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) return { given: trimmed, family: "" };
  return { given: trimmed.slice(0, lastSpace), family: trimmed.slice(lastSpace + 1) };
}

/** A vCard 3.0 text block (RFC 6350) for one contact - CRLF line endings, as the spec requires, not
 * the `\n` the rest of this file's templates use. */
export function buildVCard(contact: VCardContact): string {
  const { given, family } = splitName(contact.fullName);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardText(contact.fullName)}`,
    `N:${escapeVCardText(family)};${escapeVCardText(given)};;;`,
  ];
  if (contact.email) lines.push(`EMAIL:${escapeVCardText(contact.email)}`);
  if (contact.phone) lines.push(`TEL:${escapeVCardText(contact.phone)}`);
  lines.push("END:VCARD");
  return lines.map((line) => `${line}\r\n`).join("");
}

/** A `data:` URI a browser can download as a `.vcf` with no backend - built from `buildVCard`. */
export function vCardDataUrl(contact: VCardContact): string {
  return `data:text/vcard;charset=utf-8,${encodeURIComponent(buildVCard(contact))}`;
}

/** Email and phone as clickable `mailto:`/`tel:` links, plus a vCard download link - `""` when
 * there's neither to show. Shared by a roster member's own contact line and a shared guardian's. */
function renderContactLinks(fullName: string, email: string | null, phone: string | null): string {
  const links: string[] = [];
  if (email) links.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
  if (phone) links.push(`<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`);
  if (links.length === 0) return "";
  const vcard = vCardDataUrl({ fullName, email, phone });
  links.push(`<a href="${escapeHtml(vcard)}" download="${escapeHtml(fullName)}.vcf">Add to contacts</a>`);
  return links.join(" · ");
}

function renderGuardianContact(contact: GuardianContact): string {
  const links = renderContactLinks(contact.fullName, contact.email, contact.phone);
  const details = links.length > 0 ? `: ${links}` : "";
  return `<p class="roster-contact">${escapeHtml(contact.fullName)}${details}</p>`;
}

function renderMember(member: TeamMember): string {
  const school = member.school ? `<p class="roster-school">${escapeHtml(member.school)}</p>` : "";
  const links = renderContactLinks(member.fullName, member.email, member.phone);
  const contact = links.length > 0 ? `<p class="roster-contact">${links}</p>` : "";
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

/** A minor's own email and phone are never shown, only their guardians' — wording a guardian shares
 * their own details (#166), not the child's. */
function renderShareToggle(row: ShareToggleRow): string {
  const program = escapeHtml(row.programName);
  const text = row.isSelf
    ? `Share your contact info with your ${program} teammates`
    : `Share your family's contact info with ${escapeHtml(row.firstName)}'s ${program} teammates`;
  const registrationIds = row.registrationIds.map(escapeHtml).join(",");
  return `        <label class="roster-toggle">
          <input type="checkbox" class="roster-share-toggle" data-registration-ids="${registrationIds}"${row.checked ? " checked" : ""} />
          ${text}
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

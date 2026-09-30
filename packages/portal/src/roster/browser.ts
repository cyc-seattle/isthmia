/**
 * The roster section's only impure code: fetches from Directus and mounts the result into
 * `#roster-root`. Compiled separately from the rest of the package (`../../tsconfig.client.json`,
 * DOM lib, no bundler) and served as-is — see `packages/portal/README.md`.
 *
 * Directus's session cookie is host-only and `SameSite=Lax`; `directus.<host>` and this page share
 * a registrable domain, so a same-site `fetch` carries it with no token ever touching this script.
 */
import { decideAuthAction, type AuthAction } from "./auth.js";
import {
  buildRoster,
  familyMembers,
  familyOptedIn,
  filterMembers,
  groupByProgram,
  schoolOptions,
  teamOptions,
  NO_FILTER,
  type RawEntry,
  type RawPerson,
  type RosterFilter,
} from "./model.js";
import { renderRoster, renderRosterBlocked, renderRosterError, renderRosterLoading } from "./render.js";

const REDIRECT_FLAG = "cyc-roster-auth-redirect";

function directusBaseUrl(): string {
  return `https://directus.${window.location.hostname}`;
}

function signInUrl(base: string): string {
  const redirect = encodeURIComponent(window.location.href);
  return `${base}/auth/login/authentik?redirect=${redirect}`;
}

/** `GET /users/me` needs a real Directus session — the public role has no permission on
 * `directus_users`, so an anonymous request is rejected (401 or 403 depending on why) instead of
 * answered with an empty result. */
async function hasDirectusSession(base: string): Promise<boolean> {
  const response = await fetch(`${base}/users/me?fields=id`, { credentials: "include" });
  return response.ok;
}

function readLastRedirectAt(): number | null {
  const raw = window.sessionStorage.getItem(REDIRECT_FLAG);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchItems<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Directus request failed: ${String(response.status)}`);
  const body = (await response.json()) as { data: T[] };
  return body.data;
}

function entriesUrl(base: string): string {
  const fields = [
    "id",
    "class_id.id",
    "class_id.name",
    "class_id.program_id.id",
    "class_id.program_id.name",
    "registration_id.participant_id.person_id",
  ].join(",");
  return `${base}/items/registration_entries?limit=-1&fields=${fields}`;
}

function peopleUrl(base: string): string {
  const fields = ["id", "first_name", "last_name", "school", "email", "phone", "share_contact"].join(",");
  return `${base}/items/people?limit=-1&fields=${fields}`;
}

async function patchShareContact(base: string, personId: string, value: boolean): Promise<void> {
  const response = await fetch(`${base}/items/people/${encodeURIComponent(personId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ share_contact: value }),
  });
  if (!response.ok) throw new Error(`Directus update failed: ${String(response.status)}`);
}

function applyAuthAction(action: AuthAction, root: HTMLElement): boolean {
  if (action.kind === "proceed") {
    window.sessionStorage.removeItem(REDIRECT_FLAG);
    return true;
  }
  if (action.kind === "blocked") {
    root.innerHTML = renderRosterBlocked(action.signInUrl);
    return false;
  }
  window.sessionStorage.setItem(REDIRECT_FLAG, String(Date.now()));
  window.location.assign(action.url);
  return false;
}

async function main(): Promise<void> {
  const rootElement = document.getElementById("roster-root");
  if (!rootElement) return;
  // Named as a fresh, definitely-non-null const: TS's narrowing of `rootElement` doesn't carry into
  // the nested `draw` function declaration and event listener below.
  const root: HTMLElement = rootElement;
  root.innerHTML = renderRosterLoading();

  const base = directusBaseUrl();
  let signedIn: boolean;
  try {
    signedIn = await hasDirectusSession(base);
  } catch {
    root.innerHTML = renderRosterError("Couldn't load your roster right now. Try reloading the page.");
    return;
  }
  const action = decideAuthAction({
    signedIn,
    lastRedirectAt: readLastRedirectAt(),
    now: Date.now(),
    signInUrl: signInUrl(base),
  });
  if (!applyAuthAction(action, root)) return;

  let entries: RawEntry[];
  let people: RawPerson[];
  try {
    [entries, people] = await Promise.all([
      fetchItems<RawEntry>(entriesUrl(base)),
      fetchItems<RawPerson>(peopleUrl(base)),
    ]);
  } catch {
    root.innerHTML = renderRosterError("Couldn't load your roster right now. Try reloading the page.");
    return;
  }

  const members = buildRoster(entries, people);
  let family = familyMembers(people);
  let filter: RosterFilter = NO_FILTER;

  function draw(): void {
    const filtered = filterMembers(members, filter);
    root.innerHTML = renderRoster({
      groups: groupByProgram(filtered),
      teams: teamOptions(members),
      schools: schoolOptions(members),
      filter,
      family: family.length > 0 ? { checked: familyOptedIn(family) } : null,
    });
  }

  draw();

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement)) return;

    if (target.id === "roster-team-filter") {
      filter = { ...filter, team: target.value || null };
      draw();
      return;
    }
    if (target.id === "roster-school-filter") {
      filter = { ...filter, school: target.value || null };
      draw();
      return;
    }
    if (target.id === "roster-share-toggle" && target instanceof HTMLInputElement) {
      const checkbox = target;
      const value = checkbox.checked;
      checkbox.disabled = true;
      Promise.all(family.map((person) => patchShareContact(base, person.id, value)))
        .then(() => {
          family = family.map((person) => ({ ...person, share_contact: value }));
        })
        .catch(() => {
          checkbox.checked = !value;
          window.alert("Couldn't update your sharing preference. Try again.");
        })
        .finally(() => {
          checkbox.disabled = false;
          draw();
        });
    }
  });
}

void main().catch((error: unknown) => {
  console.error("Roster failed to load", error);
});

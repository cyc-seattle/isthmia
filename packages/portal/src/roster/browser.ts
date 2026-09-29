/**
 * The roster section's only impure code: fetches from Directus and mounts the result into
 * `#roster-root`. Compiled separately from the rest of the package (`../../tsconfig.client.json`,
 * DOM lib, no bundler) and served as-is — see `packages/portal/README.md`.
 *
 * Directus's session cookie is host-only and `SameSite=Lax`; `directus.<host>` and this page share
 * a registrable domain, so a same-site `fetch` carries it with no token ever touching this script.
 */
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
import { renderRoster, renderRosterError, renderRosterLoading } from "./render.js";

const REDIRECT_FLAG = "cyc-roster-auth-redirect";

class AuthRequiredError extends Error {}

function directusBaseUrl(): string {
  return `https://directus.${window.location.hostname}`;
}

async function fetchItems<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { credentials: "include" });
  if (response.status === 401) throw new AuthRequiredError();
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

/** Redirects once per session — a second 401 after coming back means sign-in isn't going to
 * succeed, so we stop instead of looping. */
function redirectToDirectusLogin(base: string, root: HTMLElement): void {
  if (window.sessionStorage.getItem(REDIRECT_FLAG) === "1") {
    root.innerHTML = renderRosterError(
      "Sign-in didn't complete. Reload the page, or write to info@cyccommunitysailing.org.",
    );
    return;
  }
  window.sessionStorage.setItem(REDIRECT_FLAG, "1");
  const redirect = encodeURIComponent(window.location.href);
  window.location.assign(`${base}/auth/login/authentik?redirect=${redirect}`);
}

async function main(): Promise<void> {
  const rootElement = document.getElementById("roster-root");
  if (!rootElement) return;
  // Named as a fresh, definitely-non-null const: TS's narrowing of `rootElement` doesn't carry into
  // the nested `draw` function declaration and event listener below.
  const root: HTMLElement = rootElement;
  root.innerHTML = renderRosterLoading();

  const base = directusBaseUrl();
  let entries: RawEntry[];
  let people: RawPerson[];
  try {
    [entries, people] = await Promise.all([
      fetchItems<RawEntry>(entriesUrl(base)),
      fetchItems<RawPerson>(peopleUrl(base)),
    ]);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      redirectToDirectusLogin(base, root);
      return;
    }
    root.innerHTML = renderRosterError("Couldn't load your roster right now. Try reloading the page.");
    return;
  }
  window.sessionStorage.removeItem(REDIRECT_FLAG);

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

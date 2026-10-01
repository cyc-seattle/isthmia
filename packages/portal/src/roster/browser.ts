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
  familyIds,
  familyMembers,
  familyOptedIn,
  filterMembers,
  groupByProgram,
  guardianContactsByChild,
  schoolOptions,
  teamOptions,
  ACTIVE_CAMP_FILTER,
  NO_FILTER,
  type RawEntry,
  type RawGuardianLink,
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

/** Builds a `GET /items/<collection>` URL, `filter` as a JSON query param so a nested condition
 * (an `_and`, a related field) doesn't need Directus's bracket-path syntax spelled out by hand. */
function itemsUrl(
  base: string,
  collection: string,
  fields: readonly string[],
  filter?: Record<string, unknown>,
): string {
  const params = new URLSearchParams({ limit: "-1", fields: fields.join(",") });
  if (filter) params.set("filter", JSON.stringify(filter));
  return `${base}/items/${collection}?${params.toString()}`;
}

/** Active-camp is added here, not left to the `names` policy alone (finding 5, #166): Staff's own
 * role reads `registration_entries` with no camp restriction at all (Clubspot, not this rule, owns
 * that data), so without this the roster section would show Staff every past camp's roster too. A
 * family's own read is already scoped to Active camps by the `names` policy's `TEAM_ENTRY` filter;
 * this simply applies the same condition for every viewer, not only the ones the permission system
 * already restricts. */
function entriesUrl(base: string): string {
  return itemsUrl(
    base,
    "registration_entries",
    [
      "id",
      "class_id.id",
      "class_id.name",
      "class_id.program_id.id",
      "class_id.program_id.name",
      "registration_id.participant_id.person_id",
    ],
    { class_id: { camp_id: ACTIVE_CAMP_FILTER } },
  );
}

function peopleUrl(base: string): string {
  return itemsUrl(base, "people", ["id", "first_name", "last_name", "school", "email", "phone", "share_contact"]);
}

/** The signed-in viewer's own outgoing guardian links (`family` policy), filtered explicitly by
 * `$CURRENT_USER.email` in the request itself - not merely relying on the policy's own filter - so
 * `familyIds` never has to guess a write target from a read some other policy happened to grant
 * (finding 1, #166). */
function guardianLinksUrl(base: string): string {
  return itemsUrl(base, "contacts", ["subject_id", "contact_id", "relationship_type"], {
    _and: [{ relationship_type: { _eq: "guardian" } }, { contact_id: { email: { _eq: "$CURRENT_USER.email" } } }],
  });
}

/** The other half of `familyIds`: the viewer's own `people` row, matched explicitly by email - an
 * adult acting for themselves rather than as anyone's guardian. */
function selfUrl(base: string): string {
  return itemsUrl(base, "people", ["id", "first_name", "last_name", "share_contact"], {
    email: { _eq: "$CURRENT_USER.email" },
  });
}

/** Guardian links for every opted-in teammate (`contacts` policy, finding 2, #166) - unfiltered,
 * since the policy's own permission already scopes this to the right rows, and unlike
 * `guardianLinksUrl` above nothing here is used to pick a write target. */
function guardianContactLinksUrl(base: string): string {
  return itemsUrl(base, "contacts", ["subject_id", "contact_id", "relationship_type"]);
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
  let guardianLinks: RawGuardianLink[];
  let selfRows: RawPerson[];
  let guardianContactLinks: RawGuardianLink[];
  try {
    [entries, people, guardianLinks, selfRows, guardianContactLinks] = await Promise.all([
      fetchItems<RawEntry>(entriesUrl(base)),
      fetchItems<RawPerson>(peopleUrl(base)),
      fetchItems<RawGuardianLink>(guardianLinksUrl(base)),
      fetchItems<RawPerson>(selfUrl(base)),
      fetchItems<RawGuardianLink>(guardianContactLinksUrl(base)),
    ]);
  } catch {
    root.innerHTML = renderRosterError("Couldn't load your roster right now. Try reloading the page.");
    return;
  }

  const members = buildRoster(entries, people, guardianContactsByChild(guardianContactLinks, people));
  let family = familyMembers(people, familyIds(guardianLinks, selfRows));
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

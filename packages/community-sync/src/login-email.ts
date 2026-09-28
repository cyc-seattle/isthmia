import { isValidEmail, normalizeEmail } from "@cyc-seattle/crm";
import { PersonWithLoginEmail } from "./schema.js";

/**
 * The login email a person's `people.email` resolves to: `normalizeEmail` trims and lowercases it,
 * or null when the address isn't even plausibly deliverable (`isValidEmail`). This is the one
 * login-to-person mapping the sync keeps, and only for case - a shared address needs no mapping,
 * since Directus's `_eq` matches every row that carries it.
 */
export function computeLoginEmail(email: string | null): string | null {
  if (email == null || !isValidEmail(email)) {
    return null;
  }
  return normalizeEmail(email);
}

export interface LoginEmailUpdate {
  id: string;
  login_email: string | null;
}

export interface LoginEmailPlan {
  updates: LoginEmailUpdate[];
  /** Rows with no `id` - nothing to key a write on. Directus always returns one; this only ever
   * fires against malformed test data. */
  skipped: number;
}

/**
 * Every `people` row whose `login_email` doesn't already match what `computeLoginEmail` would
 * write - the whole point of comparing against the current value is to make a run's `sync_runs`
 * counts describe drift, not a full-table no-op rewrite every time.
 */
export function planLoginEmailUpdates(people: readonly PersonWithLoginEmail[]): LoginEmailPlan {
  const updates: LoginEmailUpdate[] = [];
  let skipped = 0;

  for (const person of people) {
    if (!person.id) {
      skipped++;
      continue;
    }
    const loginEmail = computeLoginEmail(person.email);
    if (loginEmail !== (person.login_email ?? null)) {
      updates.push({ id: person.id, login_email: loginEmail });
    }
  }

  return { updates, skipped };
}

import { isValidEmail, normalizeEmail, PersonRow } from "@cyc-seattle/crm";
import { GoogleGroupMembershipRow } from "./schema.js";

export interface MembershipRowUpdate {
  id: string;
  patch: Partial<Omit<GoogleGroupMembershipRow, "id">>;
}

/** What one program group's membership task writes: Google adds first, then the rows that record them. */
export interface MembershipWritePlan {
  add: string[];
  create: Omit<GoogleGroupMembershipRow, "id">[];
  update: MembershipRowUpdate[];
}

/** A person's row in one group. Rows are keyed by group and person, but a person merge can leave
 * two; a removed one wins, so a merge never undoes a removal. */
function rowFor(rows: readonly GoogleGroupMembershipRow[]): GoogleGroupMembershipRow | undefined {
  return rows.find((row) => row.removed_at != null) ?? rows[0];
}

/**
 * Plans one program group's membership writes from its planned people, its live members, and the
 * `google_group_memberships` rows the sync has already written for it (#265):
 *
 * | Live? | Row               | Action                                  |
 * | ----- | ----------------- | --------------------------------------- |
 * | yes   | none              | write a row                             |
 * | yes   | `removed_at` null | nothing                                 |
 * | yes   | `removed_at` set  | clear `removed_at`                      |
 * | no    | none              | add, and write a row                    |
 * | no    | `removed_at` null | set `removed_at`, don't add             |
 * | no    | `removed_at` set  | skip                                    |
 *
 * People are matched to rows by person, and to live members by their current email. A row whose
 * email differs from the person's current one recorded an old address, so it says nothing about
 * the new one: the sync adds the new address and updates the row. People who share an address
 * share its fate: if any of them has a row that records it removed, nobody re-adds it.
 */
export function planMembershipWrites(
  groupId: string,
  people: readonly Pick<PersonRow, "id" | "email">[],
  liveEmails: ReadonlySet<string>,
  rows: readonly GoogleGroupMembershipRow[],
  now: Date,
): MembershipWritePlan {
  const timestamp = now.toISOString();
  const live = new Set([...liveEmails].map(normalizeEmail));

  const rowsByPerson = new Map<string, GoogleGroupMembershipRow[]>();
  for (const row of rows) {
    if (row.group_id === groupId) {
      rowsByPerson.set(row.person_id, [...(rowsByPerson.get(row.person_id) ?? []), row]);
    }
  }

  const peopleByEmail = new Map<string, string[]>();
  for (const person of people) {
    if (!person.id || !person.email || !isValidEmail(person.email)) {
      continue;
    }
    const email = normalizeEmail(person.email);
    const ids = peopleByEmail.get(email) ?? [];
    if (!ids.includes(person.id)) {
      peopleByEmail.set(email, [...ids, person.id]);
    }
  }

  const plan: MembershipWritePlan = { add: [], create: [], update: [] };
  const create = (personId: string, email: string): void => {
    plan.create.push({ group_id: groupId, person_id: personId, email, added_at: timestamp, removed_at: null });
  };

  for (const [email, personIds] of [...peopleByEmail].sort(([a], [b]) => a.localeCompare(b))) {
    const entries = personIds.map((personId) => ({ personId, row: rowFor(rowsByPerson.get(personId) ?? []) }));

    if (live.has(email)) {
      for (const { personId, row } of entries) {
        if (!row?.id) {
          create(personId, email);
          continue;
        }
        const patch: MembershipRowUpdate["patch"] = {};
        if (row.removed_at != null) {
          patch.removed_at = null;
        }
        if (normalizeEmail(row.email) !== email) {
          patch.email = email;
        }
        if (Object.keys(patch).length > 0) {
          plan.update.push({ id: row.id, patch });
        }
      }
      continue;
    }

    const removed = entries.some(
      ({ row }) => row != null && (row.removed_at != null || normalizeEmail(row.email) === email),
    );
    if (removed) {
      for (const { row } of entries) {
        if (!row?.id) {
          continue;
        }
        const patch: MembershipRowUpdate["patch"] = {};
        if (row.removed_at == null) {
          patch.removed_at = timestamp;
        }
        if (normalizeEmail(row.email) !== email) {
          patch.email = email;
        }
        if (Object.keys(patch).length > 0) {
          plan.update.push({ id: row.id, patch });
        }
      }
      continue;
    }

    plan.add.push(email);
    for (const { personId, row } of entries) {
      if (row?.id) {
        plan.update.push({ id: row.id, patch: { email, added_at: timestamp } });
      } else {
        create(personId, email);
      }
    }
  }

  return plan;
}

/** The people whose row in `groupId` records them as removed - the audit treats them as intentionally absent. */
export function removedPersonIds(groupId: string, rows: readonly GoogleGroupMembershipRow[]): Set<string> {
  return new Set(rows.filter((row) => row.group_id === groupId && row.removed_at != null).map((row) => row.person_id));
}

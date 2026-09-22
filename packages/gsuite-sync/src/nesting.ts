import { GoogleGroupRow } from "./schema.js";

export interface GroupNesting {
  child: GoogleGroupRow;
  parent: GoogleGroupRow;
}

/**
 * Which `google_groups` rows nest under another, resolved from `parent_id` - a class group
 * resolves to its program group this way. A row with no `parent_id`, or one pointing at a row
 * that no longer exists, has nothing to nest.
 */
export function planGroupNesting(groups: readonly GoogleGroupRow[]): GroupNesting[] {
  const groupById = new Map(groups.filter((group) => group.id).map((group) => [group.id as string, group]));

  const nestings: GroupNesting[] = [];
  for (const child of groups) {
    if (!child.parent_id) {
      continue;
    }
    const parent = groupById.get(child.parent_id);
    if (parent) {
      nestings.push({ child, parent });
    }
  }
  return nestings;
}

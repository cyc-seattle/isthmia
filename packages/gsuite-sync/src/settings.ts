import { GoogleGroupRow } from "./schema.js";

/**
 * Which `google_groups` rows the settings pass should apply a template to: every non-archived row
 * with a `settings_template` set. A row with none is left exactly as configured by hand, which is
 * how a group opts out of managed settings. An archived row is skipped regardless - it no longer
 * exists in Workspace to apply anything to.
 */
export function planGroupsWithSettings(groups: readonly GoogleGroupRow[]): GoogleGroupRow[] {
  return groups.filter((group) => group.settings_template != null && !group.archived);
}

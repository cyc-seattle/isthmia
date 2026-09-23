import { GoogleGroupRow } from "./schema.js";

/**
 * Which `google_groups` rows the settings pass should apply a template to: every row with a
 * `settings_template` set. A row with none is left exactly as configured by hand, which is how a
 * group opts out of managed settings.
 */
export function planGroupsWithSettings(groups: readonly GoogleGroupRow[]): GoogleGroupRow[] {
  return groups.filter((group) => group.settings_template != null);
}

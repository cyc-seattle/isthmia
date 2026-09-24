import { GroupSettings, resolveGroupSettingsTemplate } from "@cyc-seattle/gsuite";
import { AuditFindingInput, GSUITE_SYNC_SOURCE } from "./audit.js";
import { GoogleGroupRow } from "./schema.js";

/** The slice of `GroupSettingsClient` the settings-drift check reads through - narrow enough that
 * a real instance satisfies it structurally, matching `SettingsApplier`'s pattern. Kept separate
 * from that write-side interface since a dropped write pass shouldn't have to keep a reader it no
 * longer calls. */
export interface SettingsReader {
  getSettings(groupEmail: string): Promise<GroupSettings>;
}

/**
 * `settings_drift` finding for one group: live settings differing from `group.settings_template`'s
 * resolved template on any field the template sets. Only the template's own fields are compared -
 * the Groups Settings API returns many fields the sync doesn't manage, and `patchSettings` only
 * ever touches the ones in the template (see `settings-writer.ts`), so drift elsewhere isn't this
 * sync's problem. An unresolvable template name throws, same as the settings pass itself.
 *
 * Kept in its own module, called from its own step in the audit pass, so both can be deleted
 * together if the Groups Settings API rejects the sync's credential (see the README's "Open
 * questions") without touching the other four finding kinds.
 */
export function findSettingsDrift(
  group: Pick<GoogleGroupRow, "email" | "settings_template">,
  liveSettings: GroupSettings,
): AuditFindingInput[] {
  const template = resolveGroupSettingsTemplate(group.settings_template as string) as Record<string, unknown>;
  const live = liveSettings as Record<string, unknown>;

  const driftedFields = Object.keys(template)
    .filter((field) => JSON.stringify(live[field]) !== JSON.stringify(template[field]))
    .sort();

  if (driftedFields.length === 0) {
    return [];
  }
  return [
    {
      source: GSUITE_SYNC_SOURCE,
      kind: "settings_drift",
      subject: group.email,
      detail: `Live settings differ from settings_template on: ${driftedFields
        .map((field) => `${field} (live ${JSON.stringify(live[field])}, template ${JSON.stringify(template[field])})`)
        .join(", ")}`,
    },
  ];
}

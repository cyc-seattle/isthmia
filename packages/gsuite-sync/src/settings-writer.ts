import winston from "winston";
import { GroupSettings } from "@cyc-seattle/gsuite";

/** The slice of `GroupSettingsClient` the settings pass writes through - narrow enough that a
 * `GroupSettingsClient` instance satisfies it structurally, with no wrapping needed for a real run. */
export interface SettingsApplier {
  patchSettings(groupEmail: string, settings: GroupSettings): Promise<GroupSettings>;
}

/** `GroupSettingsClient` has no built-in dry-run mode, unlike `DirectusClient` - this stands in for
 * it on the Google side of a `--dry-run` run, logging the write instead of making it. */
export function dryRunSettingsApplier(): SettingsApplier {
  return {
    async patchSettings(groupEmail, settings) {
      winston.info("Dry run: skipping apply group settings", { groupEmail, settings });
      return settings;
    },
  };
}

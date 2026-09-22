/** The break-glass super-admin today - `commander@` joins once #81 lands. Only a default; the
 * `--group-owners` CLI flag is what actually changes when that happens. */
export const DEFAULT_GROUP_OWNERS: readonly string[] = ["master@cyccommunitysailing.org"];

/**
 * The addresses the owners pass grants OWNER on every group - config, never CRM data (see the
 * design doc's "Group owners are config constants"). Normalizes and dedupes in case the config
 * repeats an address.
 */
export function planGroupOwners(configuredOwners: readonly string[]): string[] {
  const emails = configuredOwners.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0);
  return [...new Set(emails)].sort();
}

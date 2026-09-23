/**
 * The addresses the owners pass grants OWNER on every group - config, never CRM data (see the
 * README's "Group owners come from config, not the CRM"). Normalizes and dedupes in case the
 * config repeats an address.
 */
export function planGroupOwners(configuredOwners: readonly string[]): string[] {
  const emails = configuredOwners.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0);
  return [...new Set(emails)].sort();
}

/**
 * Whether an address is plausibly deliverable. Clubspot contact fields hold phone numbers, bare
 * surnames and typos, so callers that can't tolerate a bad address should check this before using
 * one.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email.trim()) && !email.includes("..");
}

/**
 * Pure decision logic for the roster's sign-in redirect. No fetch, no DOM, no `sessionStorage` —
 * `browser.ts` does that I/O and hands the results here.
 */

/** A redirect inside this window of a previous one means sign-in isn't completing, so we stop
 * looping and let the visitor retry by hand instead. */
export const REDIRECT_GUARD_MS = 2 * 60 * 1000;

export type AuthAction =
  | { readonly kind: "proceed" }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "blocked"; readonly signInUrl: string };

export interface AuthDecisionInput {
  readonly signedIn: boolean;
  readonly lastRedirectAt: number | null;
  readonly now: number;
  readonly signInUrl: string;
}

export function decideAuthAction(input: AuthDecisionInput): AuthAction {
  if (input.signedIn) return { kind: "proceed" };
  if (input.lastRedirectAt !== null && input.now - input.lastRedirectAt < REDIRECT_GUARD_MS) {
    return { kind: "blocked", signInUrl: input.signInUrl };
  }
  return { kind: "redirect", url: input.signInUrl };
}

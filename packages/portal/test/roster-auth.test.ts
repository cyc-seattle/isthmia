import { describe, it, expect } from "vitest";
import { decideAuthAction, REDIRECT_GUARD_MS } from "../src/roster/auth.js";

const SIGN_IN_URL = "https://directus.example.com/auth/login/authentik?redirect=https%3A%2F%2Fexample.com%2Froster";

describe("decideAuthAction", () => {
  it("proceeds when the viewer has a session, regardless of any past redirect", () => {
    expect(decideAuthAction({ signedIn: true, lastRedirectAt: null, now: 1000, signInUrl: SIGN_IN_URL })).toEqual({
      kind: "proceed",
    });
    expect(decideAuthAction({ signedIn: true, lastRedirectAt: 999, now: 1000, signInUrl: SIGN_IN_URL })).toEqual({
      kind: "proceed",
    });
  });

  it("redirects when the viewer has no session and no past redirect", () => {
    expect(decideAuthAction({ signedIn: false, lastRedirectAt: null, now: 1000, signInUrl: SIGN_IN_URL })).toEqual({
      kind: "redirect",
      url: SIGN_IN_URL,
    });
  });

  it("blocks a second redirect inside the guard window", () => {
    const now = 1_000_000;
    const lastRedirectAt = now - (REDIRECT_GUARD_MS - 1);
    expect(decideAuthAction({ signedIn: false, lastRedirectAt, now, signInUrl: SIGN_IN_URL })).toEqual({
      kind: "blocked",
      signInUrl: SIGN_IN_URL,
    });
  });

  it("redirects again once the guard window has fully elapsed", () => {
    const now = 1_000_000;
    const lastRedirectAt = now - REDIRECT_GUARD_MS;
    expect(decideAuthAction({ signedIn: false, lastRedirectAt, now, signInUrl: SIGN_IN_URL })).toEqual({
      kind: "redirect",
      url: SIGN_IN_URL,
    });
  });
});

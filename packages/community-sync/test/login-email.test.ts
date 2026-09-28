import { describe, expect, it } from "vitest";
import { computeLoginEmail, planLoginEmailUpdates } from "../src/login-email.js";
import { PersonWithLoginEmail } from "../src/schema.js";

function person(overrides: Partial<PersonWithLoginEmail> = {}): PersonWithLoginEmail {
  return {
    id: "p1",
    first_name: "Ada",
    last_name: null,
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    login_email: null,
    ...overrides,
  };
}

describe("computeLoginEmail", () => {
  it("trims and lowercases a valid email", () => {
    expect(computeLoginEmail("  A@Example.com  ")).toBe("a@example.com");
  });

  it("returns null for a null email", () => {
    expect(computeLoginEmail(null)).toBeNull();
  });

  it("returns null for an email isValidEmail rejects", () => {
    expect(computeLoginEmail("not-an-email")).toBeNull();
    expect(computeLoginEmail("555-1234")).toBeNull();
  });
});

describe("planLoginEmailUpdates", () => {
  it("plans an update for a person whose login_email has drifted", () => {
    const people = [person({ id: "p1", email: "A@Example.com", login_email: null })];

    const { updates, skipped } = planLoginEmailUpdates(people);

    expect(updates).toEqual([{ id: "p1", login_email: "a@example.com" }]);
    expect(skipped).toBe(0);
  });

  it("plans no update when login_email already matches", () => {
    const people = [person({ id: "p1", email: "a@example.com", login_email: "a@example.com" })];

    const { updates } = planLoginEmailUpdates(people);

    expect(updates).toEqual([]);
  });

  it("plans clearing login_email when the email becomes invalid", () => {
    const people = [person({ id: "p1", email: "not-an-email", login_email: "old@example.com" })];

    const { updates } = planLoginEmailUpdates(people);

    expect(updates).toEqual([{ id: "p1", login_email: null }]);
  });

  it("skips and counts a row with no id", () => {
    const withoutId: Partial<PersonWithLoginEmail> = person({ email: "a@example.com" });
    delete withoutId.id;
    const people = [withoutId as PersonWithLoginEmail];

    const { updates, skipped } = planLoginEmailUpdates(people);

    expect(updates).toEqual([]);
    expect(skipped).toBe(1);
  });
});

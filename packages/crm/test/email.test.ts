import { describe, expect, it } from "vitest";
import { isValidEmail } from "../src/email.js";

describe("isValidEmail", () => {
  it.each(["a@example.com", " Planned@Example.com ", "first.last+tag@sub.example.org"])(
    "accepts %s",
    (email: string) => {
      expect(isValidEmail(email)).toBe(true);
    },
  );

  it.each(["206-965-5407", "Bauer", "the foghorns@gmail.com", "375784022qq.com", "a..b@example.com", "N/A"])(
    "rejects %s",
    (email: string) => {
      expect(isValidEmail(email)).toBe(false);
    },
  );
});

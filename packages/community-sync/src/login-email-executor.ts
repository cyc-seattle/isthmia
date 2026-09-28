import winston from "winston";
import { DirectusClient } from "@cyc-seattle/directus";
import { planLoginEmailUpdates } from "./login-email.js";
import { PersonWithLoginEmail } from "./schema.js";

export interface LoginEmailPassResult {
  updated: number;
  skipped: number;
}

/** Reads every `people` row and writes `login_email` for whichever ones have drifted. */
export async function runLoginEmailPass(directus: DirectusClient): Promise<LoginEmailPassResult> {
  const people = await directus.readItems<PersonWithLoginEmail>("people", {
    fields: ["id", "email", "login_email"],
    limit: -1,
  });

  const { updates, skipped } = planLoginEmailUpdates(people);
  if (skipped > 0) {
    winston.warn(`Skipped ${skipped} people row(s) with no id`, { skipped });
  }
  if (updates.length > 0) {
    await directus.updateItems<PersonWithLoginEmail>("people", updates);
  }

  return { updated: updates.length, skipped };
}

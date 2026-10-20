import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBdd, test as base } from "playwright-bdd";
import { devPlatform, http, newRunId, proxyOk, secretValue } from "./support";

// Steps for features/sign-in.feature, which playwright-bdd runs through Playwright, not vitest.

interface Visitor {
  email: string;
  signInLink?: string;
}

/** Calls Authentik's users API with the bootstrap token that `authentik` wrote to its Secret. */
async function authentikUsers(method: string, path: string) {
  const api = `https://login.${(await devPlatform()).domain}/api/v3/core/users`;
  const token = await secretValue("authentik", "AUTHENTIK_BOOTSTRAP_TOKEN");
  const response = await http(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`${method} ${api}${path}: ${response.status} ${await response.text()}`);
  }
  return method === "DELETE" ? undefined : response.json();
}

async function usersWithEmail(email: string): Promise<number[]> {
  const found = await authentikUsers("GET", `/?email=${encodeURIComponent(email)}`);
  return (found.results as { pk: number }[]).map((user) => user.pk);
}

export const test = base.extend<{ visitor: Visitor }>({
  visitor: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => {
      const visitor: Visitor = { email: `visitor.${newRunId()}@example.test` };
      await use(visitor);
      for (const pk of await usersWithEmail(visitor.email)) {
        await deleteUser(pk);
      }
    },
    { timeout: 180_000 },
  ],
});

// Authentik answers 500 while the session the journey signed in with still holds an OAuth2
// authorization code, which it soon expires.
async function deleteUser(pk: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await authentikUsers("DELETE", `/${pk}/`);
    } catch (error) {
      if (attempt === 12 || !String(error).includes(": 500 ")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

const { Given, When, Then } = createBdd(test);

Given("I have an email address Authentik hasn't seen", async ({ visitor }) => {
  assert.deepEqual(await usersWithEmail(visitor.email), []);
});

When("I open the portal", async ({ page }) => {
  await page.goto(`https://${(await devPlatform()).domain}/`);
});

Then("I'm on Authentik's sign-in page", async ({ page }) => {
  const { domain } = await devPlatform();
  await expect(page).toHaveURL(new RegExp(`^https://login\\.${domain.replace(/\./g, "\\.")}/if/flow/`));
  await expect(page.locator('input[name="uidField"]')).toBeVisible();
});

When("I ask Authentik to email me a sign-in link", async ({ page, visitor }) => {
  await page.locator('input[name="uidField"]').fill(visitor.email);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(/check your inbox/i)).toBeVisible();
});

Then("the email arrives in Mailpit, with a sign-in link", async ({ visitor }) => {
  const query = encodeURIComponent(`to:"${visitor.email}"`);
  await expect
    .poll(
      async () => {
        const found = await proxyOk("mailpit", 8025, "GET", `/api/v1/search?query=${query}`);
        return found.messages?.[0]?.ID as string | undefined;
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBeTruthy();
  const found = await proxyOk("mailpit", 8025, "GET", `/api/v1/search?query=${query}`);
  const message = await proxyOk("mailpit", 8025, "GET", `/api/v1/message/${found.messages[0].ID}`);
  const href = /href="([^"]+)"/.exec(message.HTML)?.[1];
  assert.ok(href, "The email has no link.");
  visitor.signInLink = href.replace(/&amp;/g, "&");
});

When("I follow the link", async ({ page, visitor }) => {
  await page.goto(visitor.signInLink!);
  await page.getByRole("button", { name: "Continue" }).click();
});

Then("the portal shows that I'm signed in", async ({ page }) => {
  const { domain } = await devPlatform();
  await expect(page).toHaveURL(new RegExp(`^https://${domain.replace(/\./g, "\\.")}/`));
  await expect(page.getByText("You are signed in.")).toBeVisible();
});

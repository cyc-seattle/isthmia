import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

// The integration features: the sign-in journey, in a browser.
const testDir = defineBddConfig({
  features: "features/sign-in.feature",
  steps: "test/features/sign-in.steps.ts",
  outputDir: ".features-gen",
});

export default defineConfig({
  testDir,
  // Each journey waits on Authentik and on mail delivery.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { trace: "retain-on-failure" },
});

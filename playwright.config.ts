import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

// The browser journeys among the integration features. vitest runs the rest.
const testDir = defineBddConfig({
  features: "features/sign-in.feature",
  steps: "test/features/sign-in.steps.ts",
  outputDir: ".features-gen",
});

export default defineConfig({
  testDir,
  // Each journey waits on Authentik and on mail delivery.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { trace: "retain-on-failure" },
});

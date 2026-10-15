import { defineConfig } from "vitest/config";

// The integration features, against dev. `mise run test` never picks these up: they need dev's
// deploy and a Google login. features/sign-in.feature runs through Playwright instead.
export default defineConfig({
  test: {
    include: ["test/features/**/*.test.ts"],
    // A sync's Job waits for a pod on Spot capacity, then for the sync itself.
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});

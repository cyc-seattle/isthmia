import { defineConfig } from "vitest/config";

// A second, separate suite from vitest.config.ts's default include - `just test` (the default
// `vitest run`) never picks these up, since they need Docker and a Directus license (#166). Run
// with `just directus-community-test`, which brings up dev/directus-local first.
export default defineConfig({
  test: {
    include: ["packages/*/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

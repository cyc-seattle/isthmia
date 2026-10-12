import config from "@cyc-seattle/ts-config/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ...config,
  test: { ...config.test, include: ["packages/*/test/**/*.test.ts"] },
});

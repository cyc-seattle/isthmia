import config from "@cyc-seattle/ts-config/eslint";
import globals from "globals";

export default [
  ...config,
  {
    ignores: [
      "coverage",
      "**/public",
      "**/dist",
      "**/build",
      "pnpm-workspace.yaml",
      // SDKs generated at install time by scripts/gen-sdks - not ours to lint.
      "packages/infrastructure/generated/**",
    ],
  },
  // Built for the browser by tsconfig.client.json.
  { files: ["packages/portal/src/roster/**/*.ts"], languageOptions: { globals: globals.browser } },
  { rules: { "@typescript-eslint/no-explicit-any": "warn" } },
];

import config from "@cyc-seattle/ts-config/eslint";

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
  { rules: { "@typescript-eslint/no-explicit-any": "warn" } },
];

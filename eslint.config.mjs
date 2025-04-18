import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.ts'] },
  {
    ignores: [
      'coverage',
      '**/public',
      '**/dist',
      '**/build',
      '**/node_modules',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
  },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

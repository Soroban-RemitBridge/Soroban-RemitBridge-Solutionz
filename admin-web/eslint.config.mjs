// Flat ESLint config for the operator console.
//
// Type-aware rules are used here too, but a narrower set than the backend's:
// browsers are where async handlers get attached to `onClick`, which is a
// different class of mistake from a floating promise in an indexer, and flagging
// it as one would train everyone to ignore the rule.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  // The e2e stub is plain Node ESM, so it needs the Node globals and none of the
  // browser ones. It is linted rather than excluded because it is the one file in
  // the suite that decides what the app is tested against.
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    // These are Node scripts rather than React, but the plugin's recommended
    // config still applies; telling it the version keeps it from warning about
    // files that have nothing to do with React.
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Next.js uses the automatic JSX runtime.
      'react/react-in-jsx-scope': 'off',
      // Props are typed; `prop-types` would only duplicate that.
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
);

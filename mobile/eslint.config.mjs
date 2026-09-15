// Flat ESLint config for the mobile app.
//
// React hooks rules matter more here than in the web console: the sender flow
// holds a claim code across a navigation step, and a missing dependency in an
// effect there is how a code gets regenerated after the user has already written
// it down.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.expo/**', 'node_modules/**', 'expo-env.d.ts', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
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
      // React Native never uses the DOM runtime config; the automatic runtime is
      // configured through babel-preset-expo.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // React Native components are not DOM elements, so this rule only produces
      // noise about `View` and `Text`.
      'react/no-unknown-property': 'off',
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

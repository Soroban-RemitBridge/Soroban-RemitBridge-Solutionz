// Flat ESLint config.
//
// Type-aware rules are on because the failure this service most needs to prevent
// is not style: it is a floating-point amount, an unawaited contract call or a
// `any` that swallows a wrong field name in a compliance payload. Those are all
// type-level mistakes, so the type checker has to be part of linting.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An explicit `any` in this codebase is a bug report waiting to be filed;
      // an *implicit* one already fails the build via `noImplicitAny`.
      '@typescript-eslint/no-explicit-any': 'error',
      // An interface method that takes a parameter it genuinely ignores — the
      // mock provider's `revoke` — is clearer with a `_`-prefixed name than with
      // an unused binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `catch (e) { return e.message }` on an unknown is how a stack trace ends
      // up in an HTTP response. `useUnknownInCatchVariables` is on, so narrow it.
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      // Floating promises in an indexer mean a cursor advances before the write
      // it depends on has finished — silent, and very hard to notice.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Tests may reach for a loose shape when building a fixture; production code
    // may not.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);

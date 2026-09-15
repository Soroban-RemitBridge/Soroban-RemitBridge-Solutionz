import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The only setup is a fake environment: a few units import `config/env`,
    // which parses and validates the environment at import time on purpose. No
    // test here reaches a database or the chain — anything that needs either
    // belongs in an integration job against a real deployment, not in a unit
    // suite that would then need Docker to run.
    setupFiles: ['tests/setup-env.ts'],
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/router.ts', 'src/api/openapi.ts', 'src/index.ts'],
      thresholds: {
        // The excluded files are HTTP wiring and the OpenAPI document, which are
        // better exercised end to end. Everything else is business logic and is
        // held to a real bar.
        lines: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
});

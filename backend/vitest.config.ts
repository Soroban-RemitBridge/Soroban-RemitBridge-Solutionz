import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // No global setup: every test in this suite is pure (money arithmetic, event
    // decoding, provider branching, alert classification). Anything needing a
    // database or the chain belongs in an integration job that runs against a
    // real deployment, not in a unit suite that would then need Docker to run.
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

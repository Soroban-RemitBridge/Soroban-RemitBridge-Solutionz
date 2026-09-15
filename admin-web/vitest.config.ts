import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the console's server-side modules.
 *
 * `environment: 'node'` and no setup file, because everything under test is
 * deliberately free of React and of the Next runtime: the formatting helpers and
 * the response schemas. Those are also where the assertions worth making live --
 * what the console refuses to render is decided in the schemas, not in a
 * component. There is no component suite; see the README's verification table,
 * which lists that as a gap rather than as a design choice.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});

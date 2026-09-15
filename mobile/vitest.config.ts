import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `expo-crypto` is native-only. It is aliased to a `node:crypto`-backed
      // double rather than mocked per-test, so every test that hashes anything
      // is exercising the same implementation of the protocol.
      'expo-crypto': fileURLToPath(new URL('./tests/expo-crypto.double.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});

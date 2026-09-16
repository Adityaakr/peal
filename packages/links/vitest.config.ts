import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});

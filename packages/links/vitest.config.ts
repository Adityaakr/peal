import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Both suites drive the same node and chains; run files one at a time.
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The end-to-end tests deploy to one shared anvil instance with one
    // funded account. Run in parallel they interleave transactions from the
    // same address and fail with "nonce too low", which looks like a contract
    // bug and is not one. Two suites that mutate the same chain are not
    // independent, so they run one at a time.
    fileParallelism: false,
  },
});

import { defineConfig, devices } from '@playwright/test';

// Peal Links browser tests. The dev server and the local stack are started
// by scripts/peal-links/stack.sh; this config only points at them.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.EXPLORER_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

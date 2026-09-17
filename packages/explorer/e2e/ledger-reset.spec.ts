// A wallet whose account was registered on a ledger the node has since lost
// (its state did not survive a redeploy). The app must say so and offer a
// fresh start, not fail every action one by one. Run against a throwaway
// single node whose data directory the test wipes between the two halves:
//   EXPLORER_URL=http://localhost:5177 LINKS_URL=http://127.0.0.1:8799 RESET_DATA_DIR=<its data dir> RESET_CONFIG=<its config> NODE_BIN=<the node binary>
import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { injectWallet, KEYS } from './wallet';

const CHAIN = 31337;
const OUT = process.env.SHOT_DIR ?? 'test-results/ledger-reset';

async function activate(page: Page): Promise<void> {
  await page.goto('/#/bonsai/app');
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('private payments on', { exact: true })).toBeVisible({ timeout: 180_000 });
}

test('a ledger reset is reported and a fresh account can be set up for the same wallet', async ({ browser }) => {
  test.setTimeout(600_000);
  const dataDir = process.env.RESET_DATA_DIR!;
  const config = process.env.RESET_CONFIG!;
  const node = process.env.LINKS_URL!;
  const ctx = await browser.newContext();
  await injectWallet(ctx, KEYS.bob, { chainId: CHAIN });
  const page = await ctx.newPage();
  await activate(page);
  await page.screenshot({ path: `${OUT}/01-set-up.png` });

  // The node loses its state: stop it, wipe the data directory, start it.
  execSync(`pkill -f -- '--config ${config}' || true`);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(dataDir, { recursive: true, force: true });
  execSync(`sh -c 'nohup ${process.env.NODE_BIN} --config ${config} > ${dataDir}.log 2>&1 &'`);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${node}/healthz`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Same browser, same wallet, a ledger that has never heard of the account.
  await page.reload();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('has no record of the private account stored here')).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: `${OUT}/02-ledger-reset.png` });

  await page.getByRole('button', { name: 'Start over with this wallet' }).click();
  await expect(page.getByText('private payments on', { exact: true })).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: `${OUT}/03-fresh-account.png` });

  // And the fresh account is real: it can make a request on the new ledger.
  await page.getByRole('button', { name: 'New payment link' }).click();
  await page.locator('#pl-request-form input[name="title"]').fill('After the reset');
  await page.locator('#pl-request-form input[name="amount"]').fill('1');
  await page.locator('#pl-request-form').getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('#pl-link-url')).toHaveValue(/\/pay\/[a-z2-7]{24}$/, { timeout: 60_000 });
  await ctx.close();
});

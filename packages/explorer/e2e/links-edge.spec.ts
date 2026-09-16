// Edge cases against the live stack, on the wallet-only flow: terminal
// request states, a wallet that declines (sign-in, the payment approval),
// a wallet on the wrong network, a concurrent payer on a one-time request,
// and keyboard reachability. Recovery and reload-mid-checkout live in
// links-one-wallet.spec.ts.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import {
  deriveBackupKey,
  deterministicSignature,
  LinksAccount,
  loadParams,
  localSigner,
  MemoryDeviceKeys,
  MemoryStore,
  NodeClient,
  recoveryMessage,
  siweMessage,
} from 'peal-links';
import { createLocalProver } from 'peal-links/local';
import { freshWallet, injectWallet, KEYS, NODE, shot as shotTo, useWalletAccount } from './wallet';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_DIR ?? join(here, '..', '..', '..', 'docs', 'peal-links', 'evidence', 'phase-e');
const shot = (page: Parameters<typeof shotTo>[0], name: string) => shotTo(page, OUT, name);

/** A receiver set up through the SDK (one wallet, derived-key recovery),
 * for creating requests without driving the UI again. */
async function receiver(): Promise<{ client: NodeClient; account: LinksAccount }> {
  const client = new NodeClient({ baseUrl: NODE });
  const status = await client.status();
  const ns = status.namespaces[0]!;
  const prover = await createLocalProver();
  await loadParams(client, prover);
  const evm = privateKeyToAccount(KEYS.bob);
  const { nonce } = await client.nonce();
  const msg = siweMessage({ domain: 'localhost:5173', address: evm.address, uri: 'http://localhost:5173/bonsai/app', chainId: ns.chain_id, nonce });
  await client.session(msg, await evm.signMessage({ message: msg }));
  const signer = localSigner(evm, ns.chain_id);
  const sig = (await deterministicSignature(signer, recoveryMessage(signer.address, ns.label, ns.id)))!;
  const account = await LinksAccount.setup(
    { prover, client, namespace: ns.id, store: new MemoryStore(), deviceKeys: new MemoryDeviceKeys() },
    status.circuit_id,
    signer,
    'Bob',
    { mechanism: 'wallet-signature', backupKey: await deriveBackupKey(sig, signer.address, ns.id) },
  );
  return { client, account };
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('terminal request states are their own honest screens', async ({ browser }) => {
  test.setTimeout(240_000);
  const { client, account } = await receiver();
  const expired = await account.createRequest({ amount: '1000000', title: 'Expires soon', expiresAt: Math.floor(Date.now() / 1000) + 3 });
  const archived = await account.createRequest({ amount: '1000000', title: 'Archived' });
  await client.archiveRequest(archived.manifest.request_id);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${archived.manifest.request_id}`);
  await expect(page.getByText('withdrawn by its creator')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
  await shot(page, 'edge-archived');
  await page.waitForTimeout(3500);
  await page.goto(`/#/pay/${expired.manifest.request_id}`);
  await expect(page.getByText(/^expired/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
  await shot(page, 'edge-expired');
  await page.goto('/#/pay/aaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByText('request not found')).toBeVisible({ timeout: 30_000 });
  await page.goto('/#/pay/not-a-real-id');
  await expect(page.getByText('not a payment link')).toBeVisible({ timeout: 30_000 });
  await ctx.close();
});

test('a wallet that declines, and a wallet on the wrong network, are told so and can retry', async ({ browser }) => {
  test.setTimeout(300_000);
  const payer = await freshWallet();
  const { account } = await receiver();
  const req = await account.createRequest({ amount: '1000000', title: 'Rejections' });

  // Sign-in declined in the wallet: an error, and the page still works.
  const rej = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await injectWallet(rej, payer, { chainId: 31337, rejectSign: true, rejectTx: true });
  const app = await rej.newPage();
  await app.goto('/#/bonsai/app');
  await app.getByRole('button', { name: 'Use browser wallet' }).click();
  await app.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(app.getByRole('alert')).toContainText(/declined/i, { timeout: 30_000 });
  await expect(app.getByRole('button', { name: 'Continue with this wallet' })).toBeVisible();
  await shot(app, 'edge-signin-rejected');
  await rej.close();

  // Wrong network: the wallet sits on chain B and refuses to switch; the
  // request is on chain A. Setup asks the wallet to switch first, is told
  // no, and says exactly that: which chain the wallet is on and which one
  // the request needs. Nothing is signed or charged, and the page can retry.
  const wrong = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectWallet(wrong, payer, { chainId: 31338 });
  const p2 = await wrong.newPage();
  await p2.goto(`/#/pay/${req.manifest.request_id}`);
  await p2.getByRole('button', { name: 'Use browser wallet' }).click();
  await p2.getByRole('button', { name: /Continue with wallet/ }).click();
  await expect(p2.getByRole('alert')).toContainText(/on chain 31338 and the switch to local chain A \(id 31337\) was declined/, { timeout: 60_000 });
  await expect(p2.getByRole('button', { name: /Continue with wallet/ })).toBeVisible();
  await expect(p2.getByText('Payment sent.')).toHaveCount(0);
  await shot(p2, 'edge-wrong-network');
  await wrong.close();
});

test('a concurrent payer on a one-time request is held off while the first one proves', async ({ browser }) => {
  test.setTimeout(420_000);
  const payer = await freshWallet();
  const { account: bob } = await receiver();
  const req = await bob.createRequest({ amount: '2000000', title: 'One at a time' });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectWallet(ctx, payer, { chainId: 31337 });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${req.manifest.request_id}`);
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: /Continue with wallet/ }).click();
  // Alice's account exists (the one-wallet suite set it up) or is new: either
  // way she lands on a pay button, funding as part of the flow if needed.
  const payBtn = page.getByRole('button', { name: /^(Approve and pay|Pay) 2\.00/ });
  await expect(payBtn).toBeVisible({ timeout: 180_000 });
  await payBtn.click();
  await expect(page.locator('.pl-step-active', { hasText: 'Preparing payment' })).toBeVisible({ timeout: 300_000 });

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await other.newPage();
  await p2.goto(`/#/pay/${req.manifest.request_id}`);
  await expect(p2.getByText('someone is completing this payment right now')).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
  await shot(p2, 'edge-concurrent-payer');
  await other.close();

  await expect(page.getByText('Payment sent.')).toBeVisible({ timeout: 180_000 });
  await bob.sync();
  expect((await bob.view()).receipts.filter((r) => r.reference === req.manifest.request_id)).toHaveLength(1);
  await ctx.close();
});

test('checkout is reachable by keyboard', async ({ browser }) => {
  test.setTimeout(120_000);
  const { account } = await receiver();
  const req = await account.createRequest({ amount: '1000000', title: 'Keys' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await injectWallet(ctx, await freshWallet(0n), { chainId: 31337 });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${req.manifest.request_id}`);
  await expect(page.getByText('verified on this device')).toBeVisible({ timeout: 60_000 });
  // Tab from the top of the document to the wallet chooser: the first step
  // of paying must be reachable without a mouse, and both connectors
  // (browser wallet first, Privy second) must be in the tab order.
  const reached: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const desc = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).name || el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || ''}` : '';
    });
    reached.push(desc);
    if (desc === 'button:Use Privy wallet') break;
  }
  expect(reached.at(-2)).toBe('button:Use browser wallet');
  expect(reached.at(-1)).toBe('button:Use Privy wallet');
  await ctx.close();
});

test('two wallets in one browser each keep their own private account', async ({ browser }) => {
  test.setTimeout(300_000);
  // One after the other: both gas grants come from the same funder account.
  const first = await freshWallet(0n);
  const second = await freshWallet(0n);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const firstAddress = await injectWallet(ctx, [first, second], { chainId: 31337 });
  const page = await ctx.newPage();
  await page.goto('/#/bonsai/app');
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('private payments on', { exact: true })).toBeVisible({ timeout: 120_000 });

  // The person picks another account in their wallet and reloads: that
  // wallet is new here and sets up its own account; it is never told the
  // device belongs to the first wallet.
  const secondAddress = await useWalletAccount(ctx, 1);
  await page.reload();
  await expect(page.getByText('First time here')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/holds the private account/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('private payments on', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(new RegExp(`browser wallet 0x${secondAddress.slice(2, 8)}`, 'i'))).toBeVisible();
  await shot(page, 'edge-second-wallet-same-browser');

  // Back to the first wallet: its account is still here and unlocks without
  // a new setup.
  await useWalletAccount(ctx, 0);
  await page.reload();
  await expect(page.getByText('Your private account is on this device')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('private payments on', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(new RegExp(`browser wallet 0x${firstAddress.slice(2, 8)}`, 'i'))).toBeVisible();
  await ctx.close();
});

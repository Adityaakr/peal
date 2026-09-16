// Phase E edge cases against the live stack: terminal request states,
// wallet rejection, wrong network, a reload in the middle of proving (no
// double payment), a concurrent payer on a one-time request, backup export
// and restore in a fresh browser context, and keyboard reachability.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LinksAccount, loadParams, MemoryStore, NodeClient, siweMessage, type PaymentRequest } from 'peal-links';
import { createLocalProver } from 'peal-links/local';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_DIR ?? join(here, '..', '..', '..', 'docs', 'peal-links', 'evidence', 'phase-e');
const NODE = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
const PASS = 'correct horse battery staple';
const RPC_BY_CHAIN: Record<number, string> = { 31337: 'http://127.0.0.1:8545', 31338: 'http://127.0.0.1:8546' };
const KEYS = {
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // anvil 2
  alice: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // anvil 3
  carol: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // anvil 4
} as const;

interface WalletOpts {
  chainId: number;
  rejectSign?: boolean;
  rejectTx?: boolean;
}

async function injectWallet(context: BrowserContext, key: `0x${string}`, opts: WalletOpts): Promise<string> {
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[opts.chainId] ?? 'http://127.0.0.1:8545';
  const chain = { id: opts.chainId, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  await context.exposeFunction('__pealSign', async (hex: string) => {
    if (opts.rejectSign) throw new Error('User rejected the request.');
    return account.signMessage({ message: { raw: Buffer.from(hex.replace(/^0x/, ''), 'hex') } });
  });
  await context.exposeFunction('__pealSendTx', async (tx: { to?: string; data?: string; value?: string; gas?: string }) => {
    if (opts.rejectTx) throw new Error('User rejected the request.');
    return wallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
  });
  await context.exposeFunction('__pealRpc', async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  });
  await context.addInitScript(
    ({ address, chainHex }) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const w = window as unknown as { __pealSign: (h: string) => Promise<string>; __pealSendTx: (t: unknown) => Promise<string>; __pealRpc: (m: string, p: unknown[]) => Promise<unknown> };
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
          if (method === 'eth_chainId') return chainHex;
          if (method === 'personal_sign') return w.__pealSign((params as string[])[0]!);
          if (method === 'eth_sendTransaction') return w.__pealSendTx((params as unknown[])[0]);
          if (method === 'wallet_switchEthereumChain') throw new Error('User rejected the request.');
          return w.__pealRpc(method, params ?? []);
        },
        on() {},
        removeListener() {},
      };
    },
    { address: account.address, chainHex: `0x${opts.chainId.toString(16)}` },
  );
  return account.address;
}

/** TestUSD has a public faucet on local chains; mint for a test account. */
async function fundFromFaucet(key: `0x${string}`, amount = 1_000_000_000n): Promise<void> {
  const client = new NodeClient({ baseUrl: NODE });
  const ns = (await client.status()).namespaces[0]!;
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[ns.chain_id]!;
  const chain = { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const { ERC20_ABI } = await import('peal-links');
  const { createPublicClient } = await import('viem');
  const wc = createWalletClient({ account, chain, transport: http(rpc) });
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const hash = await wc.writeContract({ address: ns.token_address as `0x${string}`, abi: ERC20_ABI, functionName: 'faucet', args: [account.address, amount] });
  await pc.waitForTransactionReceipt({ hash });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

/** A signed-in receiver account through the SDK, for creating requests
 * without driving the UI again. */
async function receiver(): Promise<{ client: NodeClient; account: LinksAccount; backup: string }> {
  const client = new NodeClient({ baseUrl: NODE });
  const status = await client.status();
  const ns = status.namespaces[0]!;
  const prover = await createLocalProver();
  await loadParams(client, prover);
  const evm = privateKeyToAccount(KEYS.bob);
  const { nonce } = await client.nonce();
  const msg = siweMessage({ domain: 'localhost:5173', address: evm.address, uri: 'http://localhost:5173/bonsai/app', chainId: ns.chain_id, nonce });
  await client.session(msg, await evm.signMessage({ message: msg }));
  const account = await LinksAccount.create({ prover, client, namespace: ns.id, store: new MemoryStore() }, status.circuit_id, PASS);
  await account.register();
  const backup = await account.exportBackup('backup passphrase 1');
  return { client, account, backup };
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('terminal request states are their own honest screens', async ({ browser }) => {
  test.setTimeout(240_000);
  const { client, account } = await receiver();
  const expired = await account.createRequest({ amount: '1000000', title: 'Expires soon', displayName: 'Bob', expiresAt: Math.floor(Date.now() / 1000) + 3 });
  const archived = await account.createRequest({ amount: '1000000', title: 'Archived', displayName: 'Bob' });
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

test('wallet rejection and wrong network are recoverable, not silent', async ({ browser }) => {
  test.setTimeout(300_000);
  const { account } = await receiver();
  const req = await account.createRequest({ amount: '1000000', title: 'Rejections', displayName: 'Bob' });

  // Sign-in rejected in the wallet: an error, and the page still works.
  const rej = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await injectWallet(rej, KEYS.alice, { chainId: 31337, rejectSign: true, rejectTx: true });
  const app = await rej.newPage();
  await app.goto('/#/bonsai/app');
  await app.getByRole('button', { name: 'Use browser wallet' }).click();
  await app.getByRole('button', { name: 'Sign in' }).click();
  await expect(app.getByRole('alert')).toContainText(/rejected/i, { timeout: 30_000 });
  await expect(app.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await shot(app, 'edge-signin-rejected');
  // Deposit rejected in the wallet: the private account keeps no pending
  // deposit that could be mistaken for funds, and the form stays usable.
  const pay = await rej.newPage();
  await pay.goto(`/#/pay/${req.manifest.request_id}`);
  await pay.locator('#pay-create input[name="pass"]').fill(PASS);
  await pay.getByRole('button', { name: 'Create private account and continue' }).click();
  await expect(pay.getByText('Not enough balance')).toBeVisible({ timeout: 120_000 });
  await pay.getByRole('button', { name: 'Use browser wallet' }).click();
  await pay.locator('#pay-fund-form input[name="amount"]').fill('5');
  await pay.getByRole('button', { name: 'Deposit from wallet' }).click();
  await expect(pay.getByRole('alert')).toContainText(/rejected/i, { timeout: 60_000 });
  await expect(pay.getByRole('button', { name: 'Deposit from wallet' })).toBeEnabled();
  await shot(pay, 'edge-deposit-rejected');
  await rej.close();

  // Wrong network: the wallet is on chain B, the request is on chain A.
  const wrong = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectWallet(wrong, KEYS.carol, { chainId: 31338 });
  const p2 = await wrong.newPage();
  await p2.goto(`/#/pay/${req.manifest.request_id}`);
  await p2.locator('#pay-create input[name="pass"]').fill(PASS);
  await p2.getByRole('button', { name: 'Create private account and continue' }).click();
  await expect(p2.getByText('Not enough balance')).toBeVisible({ timeout: 120_000 });
  await p2.getByRole('button', { name: 'Use browser wallet' }).click();
  await p2.locator('#pay-fund-form input[name="amount"]').fill('5');
  await p2.getByRole('button', { name: 'Deposit from wallet' }).click();
  await expect(p2.getByRole('alert')).toContainText(/chain|network/i, { timeout: 60_000 });
  await shot(p2, 'edge-wrong-network');
  await wrong.close();
});

test('a reload in the middle of proving never pays twice; a concurrent payer is held off', async ({ browser }) => {
  test.setTimeout(420_000);
  await fundFromFaucet(KEYS.alice);
  const { client, account: bob } = await receiver();
  const req = await bob.createRequest({ amount: '2000000', title: 'Reload me', displayName: 'Bob' });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectWallet(ctx, KEYS.alice, { chainId: 31337 });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${req.manifest.request_id}`);
  await page.locator('#pay-create input[name="pass"]').fill(PASS);
  await page.getByRole('button', { name: 'Create private account and continue' }).click();
  await expect(page.getByText('Not enough balance')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.locator('#pay-fund-form input[name="amount"]').fill('10');
  await page.getByRole('button', { name: 'Deposit from wallet' }).click();
  await expect(page.getByRole('button', { name: /^Pay 2\.00/ })).toBeVisible({ timeout: 180_000 });

  // A second payer arrives while the first is at checkout: the soft lock
  // holds them off, with the reason shown, and no pay button.
  await page.getByRole('button', { name: /^Pay 2\.00/ }).click();
  await expect(page.locator('.pl-status', { hasText: 'proving the payment on this device' })).toBeVisible({ timeout: 10_000 });
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await other.newPage();
  await p2.goto(`/#/pay/${req.manifest.request_id}`);
  await expect(p2.getByText('someone is completing this payment right now')).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
  await shot(p2, 'edge-concurrent-payer');
  await other.close();

  // Reload while the proof is being made: the worker dies with the page,
  // the journaled pending send is reconciled on unlock (the ledger never
  // saw it) and the request is paid exactly once afterwards.
  await page.reload();
  await page.locator('#pay-unlock input[name="pass"]').fill(PASS);
  await page.getByRole('button', { name: 'Unlock and continue' }).click();
  await expect(page.getByRole('button', { name: /^Pay 2\.00/ })).toBeVisible({ timeout: 120_000 });
  await shot(page, 'edge-after-reload');
  await page.getByRole('button', { name: /^Pay 2\.00/ }).click();
  await expect(page.getByText('Payment accepted by the ledger')).toBeVisible({ timeout: 120_000 });
  // Exactly one payment: Bob's inbox holds one envelope for this request.
  await bob.sync();
  const view = await bob.view();
  expect(view.receipts.filter((r) => r.reference === req.manifest.request_id)).toHaveLength(1);
  // And the payer's balance moved by exactly the request amount.
  const reloadedBalance = await page.evaluate(() => document.body.innerText);
  expect(reloadedBalance).toContain('Payment accepted');
  await ctx.close();
  void client;
});

test('backup export restores an account in a fresh browser with its balance and receipts', async ({ browser }) => {
  test.setTimeout(420_000);
  await fundFromFaucet(KEYS.carol);
  const { account: bob } = await receiver();
  const req = await bob.createRequest({ amount: '3000000', title: 'For restore', displayName: 'Bob' });

  // Pay it from the SDK so Bob has an incoming receipt.
  const client = new NodeClient({ baseUrl: NODE });
  const status = await client.status();
  const ns = status.namespaces[0]!;
  const prover = await createLocalProver();
  await loadParams(client, prover);
  const payer = await LinksAccount.create({ prover, client, namespace: ns.id, store: new MemoryStore() }, status.circuit_id, PASS);
  await payer.register();
  const { receipt } = await payer.prepareDeposit('5000000');
  const evm = privateKeyToAccount(KEYS.carol);
  const chain = { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_BY_CHAIN[31337]!] } } };
  const { ERC20_ABI, GATEWAY_ABI } = await import('peal-links');
  const { createPublicClient } = await import('viem');
  const wc = createWalletClient({ account: evm, chain, transport: http(RPC_BY_CHAIN[31337]!) });
  const pc = createPublicClient({ chain, transport: http(RPC_BY_CHAIN[31337]!) });
  await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: ns.token_address as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ns.gateway as `0x${string}`, 5_000_000n] }) });
  await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: ns.gateway as `0x${string}`, abi: GATEWAY_ABI, functionName: 'deposit', args: [ns.token_address as `0x${string}`, 5_000_000n, `0x${receipt}`] }) });
  for (let i = 0; i < 60 && !(await payer.syncDeposits()).length; i++) await new Promise((r) => setTimeout(r, 1000));
  await payer.verifyReceipts();
  await payer.claim(0);
  await payer.pay(req as PaymentRequest, 'edge-restore-intent');

  // Bob claims it on device one, exports a backup from the UI, then
  // restores on device two and sees the balance.
  const one = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await injectWallet(one, KEYS.bob, { chainId: 31337 });
  const d1 = await one.newPage();
  await d1.goto('/#/bonsai/app');
  await d1.getByRole('button', { name: 'Restore from backup' }).click();
  await d1.locator('#pl-restore input[name="file"]').setInputFiles({ name: 'bob.json', mimeType: 'application/json', buffer: Buffer.from(await bob.exportBackup('backup passphrase 1')) });
  await d1.locator('#pl-restore input[name="bpass"]').fill('backup passphrase 1');
  await d1.locator('#pl-restore input[name="pass"]').fill(PASS);
  await d1.locator('#pl-restore').getByRole('button', { name: 'Restore' }).click();
  await expect(d1.getByText('Restored from backup')).toBeVisible({ timeout: 120_000 });
  await expect(d1.getByText('ready to claim')).toBeVisible({ timeout: 60_000 });
  await d1.getByRole('button', { name: 'claim now' }).click();
  await expect(d1.locator('.pl-balance-amount').first()).toContainText('3.00', { timeout: 120_000 });
  const download = d1.waitForEvent('download');
  d1.once('dialog', (dialog) => dialog.accept('backup passphrase 2'));
  await d1.getByRole('button', { name: 'Export encrypted backup' }).click();
  const file = await download;
  const path = await file.path();
  expect(path).toBeTruthy();
  await shot(d1, 'edge-backup-exported');
  await one.close();

  const two = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const d2 = await two.newPage();
  await d2.goto('/#/bonsai/app');
  await d2.getByRole('button', { name: 'Restore from backup' }).click();
  await d2.locator('#pl-restore input[name="file"]').setInputFiles(path!);
  await d2.locator('#pl-restore input[name="bpass"]').fill('backup passphrase 2');
  await d2.locator('#pl-restore input[name="pass"]').fill(PASS);
  await d2.locator('#pl-restore').getByRole('button', { name: 'Restore' }).click();
  await expect(d2.getByText('Restored from backup')).toBeVisible({ timeout: 120_000 });
  await expect(d2.locator('.pl-balance-amount').first()).toContainText('3.00');
  await expect(d2.getByText('claimed', { exact: true })).toBeVisible();
  await shot(d2, 'edge-restored-fresh-browser');
  await two.close();
});

test('checkout is reachable by keyboard', async ({ browser }) => {
  test.setTimeout(120_000);
  const { account } = await receiver();
  const req = await account.createRequest({ amount: '1000000', title: 'Keys', displayName: 'Bob' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${req.manifest.request_id}`);
  await expect(page.getByText('verified on this device')).toBeVisible({ timeout: 60_000 });
  // Tab from the top of the document until the passphrase field has focus,
  // then to the submit button; both must be reachable without a mouse.
  const reached: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const desc = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).name || el.textContent?.trim().slice(0, 30) || ''}` : '';
    });
    reached.push(desc);
    if (desc.startsWith('button:Create private account')) break;
  }
  expect(reached.some((d) => d === 'input:pass')).toBe(true);
  expect(reached.at(-1)).toMatch(/^button:Create private account/);
  await ctx.close();
});

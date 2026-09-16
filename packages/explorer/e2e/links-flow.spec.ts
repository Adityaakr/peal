// Gate C browser flow: two separate browser contexts drive the real local
// stack. The receiver creates a link and goes offline; the payer sets up a
// private account, funds it (development mint: the on-chain leg arrives in
// Phase D), and pays with a real proof made in a Web Worker; the receiver
// comes back, claims with a real proof, and the request shows as
// acknowledged.
//
// EVM wallet: the test injects a minimal EIP-1193 provider backed by a
// viem local account (anvil's public test key). That is test harness, not
// app code: the app's "Use browser wallet" path is the same one a MetaMask
// user takes, and every signature is produced by the wallet, never by the
// app.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_DIR ?? join(here, '..', '..', '..', 'docs', 'peal-links', 'evidence', 'phase-c');
const NODE = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
const PASS = 'correct horse battery staple';

const KEYS = {
  // anvil's well-known accounts 0 and 1: public test keys, never real funds.
  bob: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
} as const;

const RPC_BY_CHAIN: Record<number, string> = { 31337: 'http://127.0.0.1:8545', 31338: 'http://127.0.0.1:8546' };

async function injectWallet(context: BrowserContext, key: `0x${string}`, chainId: number): Promise<string> {
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[chainId] ?? 'http://127.0.0.1:8545';
  const chain = { id: chainId, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  await context.exposeFunction('__pealSign', async (hex: string) => {
    const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    return account.signMessage({ message: { raw: bytes } });
  });
  // Transactions are signed here, in the test process, like a wallet
  // extension would, and broadcast to anvil.
  await context.exposeFunction('__pealSendTx', async (tx: { to?: string; data?: string; value?: string; gas?: string }) => {
    return wallet.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value ? BigInt(tx.value) : undefined,
      gas: tx.gas ? BigInt(tx.gas) : undefined,
    });
  });
  // Everything else (reads, receipts) goes straight to the chain.
  await context.exposeFunction('__pealRpc', async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  });
  await context.addInitScript(
    ({ address, chainHex }) => {
      const provider = {
        isPealTestWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              return chainHex;
            case 'personal_sign': {
              const [hex] = params as [string, string];
              return (window as unknown as { __pealSign: (h: string) => Promise<string> }).__pealSign(hex);
            }
            case 'wallet_switchEthereumChain':
              return null;
            case 'eth_sendTransaction': {
              const [tx] = params as [{ to?: string; data?: string; value?: string; gas?: string }];
              return (window as unknown as { __pealSendTx: (t: unknown) => Promise<string> }).__pealSendTx(tx);
            }
            default:
              return (window as unknown as { __pealRpc: (m: string, p: unknown[]) => Promise<unknown> }).__pealRpc(method, params ?? []);
          }
        },
        on() {},
        removeListener() {},
      };
      (window as unknown as { ethereum: unknown }).ethereum = provider;
    },
    { address: account.address, chainHex: `0x${chainId.toString(16)}` },
  );
  return account.address;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

/** Every request body and URL a context sends, for the privacy assertion. */
function captureTraffic(context: BrowserContext, sink: Array<{ url: string; body: string }>): void {
  context.on('request', (r) => {
    if (r.url().includes('/links/v1/')) sink.push({ url: r.url(), body: r.postData() ?? '' });
  });
}

test('receiver creates a link, payer pays with a real proof, receiver claims later', async ({ browser }) => {
  test.setTimeout(420_000);
  const traffic: Array<{ url: string; body: string }> = [];
  const status = await (await fetch(`${NODE}/links/v1/status`)).json();
  expect(status.namespaces[0].available, 'chain A gateway must be verified by the node').toBe(true);
  const chainId = status.namespaces[0].chain_id as number;

  // ---- Bob (receiver) creates a private account and a payment link.
  const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  captureTraffic(bobCtx, traffic);
  await injectWallet(bobCtx, KEYS.bob, chainId);
  const bob = await bobCtx.newPage();
  const errors: string[] = [];
  bob.on('pageerror', (e) => errors.push(`bob: ${e}`));
  await bob.goto('/#/bonsai/app');
  await bob.getByRole('button', { name: 'Use browser wallet' }).click();
  await bob.getByRole('button', { name: 'Sign in' }).click();
  await expect(bob.getByText('signed in')).toBeVisible({ timeout: 30_000 });
  await bob.locator('#pl-create input[name="pass"]').fill(PASS);
  await bob.locator('#pl-create input[name="pass2"]').fill(PASS);
  await bob.getByRole('button', { name: 'Create private account' }).click();
  await expect(bob.getByText('Account created and registered')).toBeVisible({ timeout: 120_000 });
  await shot(bob, '01-receiver-account-created');

  await bob.getByRole('button', { name: 'New payment link' }).click();
  await bob.locator('#pl-request-form input[name="title"]').fill('Logo files, final');
  await bob.locator('#pl-request-form input[name="amount"]').fill('12.50');
  await bob.locator('#pl-request-form input[name="display"]').fill('Bob Ashdown');
  await bob.locator('#pl-request-form input[name="reference"]').fill('INV-7');
  await bob.getByRole('button', { name: 'Create link' }).click();
  const url = await bob.locator('#pl-link-url').inputValue({ timeout: 60_000 });
  expect(url).toMatch(/\/pay\/[a-z2-7]{24}$/);
  await shot(bob, '02-receiver-link-created');
  await bob.getByRole('button', { name: 'Done' }).click();
  await expect(bob.locator('.pl-list-main', { hasText: 'Logo files, final' })).toBeVisible();
  // Bob goes offline.
  await bob.close();

  // ---- Alice (payer) opens the link in a separate context.
  const aliceCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  captureTraffic(aliceCtx, traffic);
  await injectWallet(aliceCtx, KEYS.alice, chainId);
  const alice = await aliceCtx.newPage();
  alice.on('pageerror', (e) => errors.push(`alice: ${e}`));
  await alice.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await expect(alice.getByText('12.50')).toBeVisible();
  await expect(alice.getByText('verified on this device')).toBeVisible({ timeout: 60_000 });
  await shot(alice, '03-payer-checkout');
  await alice.locator('#pay-create input[name="pass"]').fill(PASS);
  await alice.getByRole('button', { name: 'Create private account and continue' }).click();
  await expect(alice.getByText('Not enough balance')).toBeVisible({ timeout: 120_000 });
  await shot(alice, '04-payer-needs-funds');
  // A real deposit from the payer's wallet: approve, deposit with the
  // receipt commitment, credited by the watcher after confirmations.
  await alice.getByRole('button', { name: 'Use browser wallet' }).click();
  await alice.locator('#pay-fund-form input[name="amount"]').fill('20');
  const mintedBefore = BigInt((await (await fetch(`${NODE}/links/v1/ledger/${status.namespaces[0].id}/accounting`)).json()).minted_total);
  await alice.getByRole('button', { name: 'Deposit from wallet' }).click();
  // Approve and deposit are signed by the test wallet, the watcher credits
  // the intent after two blocks, and the page claims it: the pay button
  // appears once the balance covers the request.
  await expect(alice.getByRole('button', { name: /^Pay 12\.50/ })).toBeVisible({ timeout: 180_000 });
  const mintedAfter = BigInt((await (await fetch(`${NODE}/links/v1/ledger/${status.namespaces[0].id}/accounting`)).json()).minted_total);
  expect(mintedAfter - mintedBefore).toBe(20_000_000n);
  await shot(alice, '05-payer-funded');
  await alice.getByRole('button', { name: /^Pay 12\.50/ }).click();
  await expect(alice.locator('.pl-status', { hasText: 'proving the payment on this device' })).toBeVisible({ timeout: 10_000 });
  await shot(alice, '06-payer-proving');
  await expect(alice.getByText('Payment accepted by the ledger')).toBeVisible({ timeout: 120_000 });
  await shot(alice, '07-payer-accepted');

  // Reloading the checkout after paying does not offer to pay again with a
  // pending state: the account reconciles and shows a balance.
  await alice.reload();
  await expect(alice.getByText('paid from this device')).toBeVisible({ timeout: 30_000 });
  await expect(alice.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
  await alice.close();

  // ---- Bob comes back on the same device, unlocks, and claims.
  const bob2 = await bobCtx.newPage();
  bob2.on('pageerror', (e) => errors.push(`bob2: ${e}`));
  await bob2.goto('/#/bonsai/app');
  await bob2.locator('#pl-unlock input[name="pass"]').fill(PASS);
  await bob2.getByRole('button', { name: 'Unlock' }).click();
  await expect(bob2.locator('.pl-list-main', { hasText: /from/ })).toBeVisible({ timeout: 60_000 });
  await expect(bob2.getByText('ready to claim')).toBeVisible({ timeout: 60_000 });
  await shot(bob2, '08-receiver-unclaimed');
  await bob2.getByRole('button', { name: 'claim now' }).click();
  await expect(bob2.getByText('claimed', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(bob2.locator('.pl-balance-amount').first()).toContainText('12.50');
  await shot(bob2, '09-receiver-claimed');
  await expect(bob2.locator('.pl-list-sub', { hasText: 'fulfilled' })).toBeVisible({ timeout: 30_000 });

  const req = await (await fetch(`${NODE}/links/v1/requests/${url.split('/').pop()}`)).json();
  expect(req.status).toBe('fulfilled');

  // ---- Bob withdraws 5 tUSD to his wallet: burn proof, committee
  // certificate, release submitted from his wallet, confirmed by the watcher.
  const ns = status.namespaces[0];
  const recipient = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const balanceOf = async (who: string): Promise<bigint> => {
    const data = `0x70a08231000000000000000000000000${who.slice(2).toLowerCase()}`;
    const res = await fetch(RPC_BY_CHAIN[chainId]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ns.token_address, data }, 'latest'] }) });
    return BigInt(((await res.json()) as { result: string }).result);
  };
  const before = await balanceOf(recipient);
  await bob2.getByRole('button', { name: 'Use browser wallet' }).click();
  await bob2.getByRole('button', { name: 'Withdraw' }).click();
  await bob2.locator('#pl-withdraw-form input[name="amount"]').fill('5');
  await bob2.locator('#pl-withdraw-form input[name="recipient"]').fill(recipient);
  await bob2.locator('#pl-withdraw-form').getByRole('button', { name: 'Withdraw' }).click();
  await expect(bob2.getByText(/Withdrawal released on/)).toBeVisible({ timeout: 180_000 });
  await shot(bob2, '10-receiver-withdrawn');
  expect((await balanceOf(recipient)) - before).toBe(5_000_000n);
  await expect(bob2.locator('.pl-balance-amount').first()).toContainText('7.50');
  await expect(bob2.getByText('confirmed on chain')).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);

  // ---- Privacy: nothing private left either browser. Wallet JSON carries
  // `spend_seed`, `enc_seed`, `balance`, `claimed` and `randomness`; the
  // passphrase never travels; and the only bodies that may carry a receipt
  // opening are the inbox posts, which are ciphertext.
  expect(traffic.length).toBeGreaterThan(20);
  for (const { url, body } of traffic) {
    for (const marker of ['spend_seed', 'enc_seed', '"claimed"', '"balance"', PASS, 'pending_deposits', 'sent_openings']) {
      expect(body, `${marker} in a request to ${url}`).not.toContain(marker);
    }
    expect(url, 'no secrets in URLs').not.toMatch(/seed|pass|opening/);
    if (url.includes('/inbox/') && body) {
      const parsed = JSON.parse(body) as { envelope?: { ciphertext?: string } };
      expect(parsed.envelope?.ciphertext, 'inbox posts carry ciphertext only').toBeTruthy();
      expect(body).not.toContain('"amount"');
    }
    if (url.endsWith('/ops') && body) {
      const keys = Object.keys(JSON.parse(body) as Record<string, unknown>).sort();
      expect(keys).toEqual(['account', 'circuit_id', 'com', 'com_new', 'namespace', 'proof', 'pubkey', 'receipt', 'root', 'signature']);
    }
  }
  await bobCtx.close();
  await aliceCtx.close();
});

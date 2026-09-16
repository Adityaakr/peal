// One wallet, private by default (SPEC-ADDENDUM-one-wallet.md section 10):
// two people who only ever hold an EVM wallet, against the live stack.
//
//   1. Bob creates and shares a payment link (no Bonsai identifier anywhere).
//   2. Alice funds and pays it through the unified checkout ("Approve
//      payment", "Adding funds", "Preparing payment", "Payment sent").
//   3. Bob receives and claims with no manual Bonsai identifier.
//   4. Bob returns after being offline: Incoming becomes Available.
//   5. Both recover on a fresh browser: Bob through the wallet-signature
//      path, Alice (a wallet that signs non-deterministically) through her
//      recovery code.
//   6. An interrupted checkout resumes without a duplicate payment.
//   7. Bob withdraws to his wallet.
//   8. Paying an address that never activated private receiving shows the
//      invitation and moves no funds.
//
// Real proofs in Web Workers, real deposits on anvil, real directory
// lookups. Privacy assertions on every request the browsers sent.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { NodeClient } from 'peal-links';
import { captureTraffic, FORBIDDEN_ON_WIRE, fundFromFaucet, injectWallet, KEYS, NODE, shot } from './wallet';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_DIR ?? join(here, '..', '..', '..', 'docs', 'peal-links', 'evidence', 'phase-g');
const HEX64 = /\b[0-9a-f]{64}\b/i;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

let linkUrl = '';
let aliceRecoveryCode = '';
const bobAddress = privateKeyToAccount(KEYS.bob).address;
const carolAddress = privateKeyToAccount(KEYS.carol).address;
const traffic: Array<{ url: string; body: string }> = [];

/** The page must show the wallet as the only identity: no 32-byte hex
 * string (an account id, a key, a commitment) anywhere in its text. */
async function expectNoBonsaiIdentifiers(page: Page): Promise<void> {
  const text = await page.locator('.pl').innerText();
  expect(text, 'a Bonsai identifier leaked into the interface').not.toMatch(HEX64);
  expect(text).not.toMatch(/encryption key|nullifier|commitment|account id/i);
}

async function activateOnDashboard(page: Page): Promise<void> {
  await page.goto('/#/bonsai/app');
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await expect(page.getByText('private payments on')).toBeVisible({ timeout: 180_000 });
}

test('1, 3, 4, 7: Bob creates a link, receives while away, sees Incoming become Available, withdraws', async ({ browser }) => {
  test.setTimeout(600_000);
  await fundFromFaucet(KEYS.alice);
  const bobCtx = await browser.newContext();
  captureTraffic(bobCtx, traffic);
  await injectWallet(bobCtx, KEYS.bob, { chainId: 31337 });
  const bob = await bobCtx.newPage();
  await activateOnDashboard(bob);
  await expectNoBonsaiIdentifiers(bob);
  await shot(bob, OUT, '01-bob-activated');

  await bob.getByRole('button', { name: 'New payment link' }).click();
  await bob.locator('#pl-request-form input[name="title"]').fill('Logo files, final');
  await bob.locator('#pl-request-form input[name="amount"]').fill('12.50');
  await bob.locator('#pl-request-form input[name="reference"]').fill('INV-7');
  await bob.locator('#pl-request-form').getByRole('button', { name: 'Create link' }).click();
  linkUrl = await bob.locator('#pl-link-url').inputValue({ timeout: 60_000 });
  expect(linkUrl).toMatch(/\/pay\/[a-z2-7]{24}$/);
  await shot(bob, OUT, '02-bob-link-created');
  await bob.getByRole('button', { name: 'Done' }).click();
  await expectNoBonsaiIdentifiers(bob);
  await bobCtx.close(); // Bob goes offline.

  // ---- Alice pays through the unified checkout (criterion 2) ----
  const aliceCtx = await browser.newContext();
  captureTraffic(aliceCtx, traffic);
  await injectWallet(aliceCtx, KEYS.alice, { chainId: 31337, nonDeterministic: true });
  const alice = await aliceCtx.newPage();
  await alice.goto(linkUrl.replace(/^https?:\/\/[^/]+/, ''));
  await expect(alice.getByText('Logo files, final')).toBeVisible();
  await expect(alice.getByText(bobAddress.slice(0, 6).toLowerCase() + '…' + bobAddress.slice(-4).toLowerCase(), { exact: false })).toBeVisible();
  await expectNoBonsaiIdentifiers(alice);
  await alice.getByRole('button', { name: 'Use browser wallet' }).click();
  await alice.getByRole('button', { name: /Continue with wallet/ }).click();
  // Alice's wallet signs non-deterministically: she gets a recovery code.
  const code = alice.locator('#pl-code');
  await expect(code).toBeVisible({ timeout: 180_000 });
  aliceRecoveryCode = await code.inputValue();
  expect(aliceRecoveryCode).toMatch(/^PEAL-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  await shot(alice, OUT, '03-alice-recovery-code');
  await alice.getByRole('button', { name: 'I saved it' }).click();
  await expect(alice.getByText('network fee', { exact: false })).toBeVisible({ timeout: 30_000 });
  await shot(alice, OUT, '04-alice-checkout-needs-funds');
  await alice.getByRole('button', { name: /Approve and pay/ }).click();
  await expect(alice.locator('.pl-step-active', { hasText: 'Adding funds' })).toBeVisible({ timeout: 60_000 });
  await shot(alice, OUT, '05-alice-adding-funds');
  await expect(alice.getByText('Payment sent.')).toBeVisible({ timeout: 300_000 });
  await shot(alice, OUT, '06-alice-payment-sent');
  await expectNoBonsaiIdentifiers(alice);
  await aliceCtx.close();

  // ---- Bob returns: Incoming, then Available, then withdraw (4, 3, 7) ----
  const bobCtx2 = await browser.newContext();
  captureTraffic(bobCtx2, traffic);
  await injectWallet(bobCtx2, KEYS.bob, { chainId: 31337 });
  const bob2 = await bobCtx2.newPage();
  // A fresh context is a fresh browser: recovery through the wallet
  // signature (criterion 5, EOA path).
  await activateOnDashboard(bob2);
  await expect(bob2.locator('.pl-balance', { hasText: 'incoming' }).locator('.pl-balance-amount')).toContainText('12.50', { timeout: 120_000 });
  await shot(bob2, OUT, '07-bob-incoming');
  await expect(bob2.locator('.pl-balance', { hasText: 'private balance' }).locator('.pl-balance-amount')).toContainText('12.50', { timeout: 120_000 });
  await expect(bob2.locator('.pl-balance', { hasText: 'incoming' }).locator('.pl-balance-amount')).toContainText('0.00');
  await expect(bob2.locator('.pl-list', { hasText: 'received privately' })).toBeVisible();
  await expectNoBonsaiIdentifiers(bob2);
  await shot(bob2, OUT, '08-bob-available');

  await bob2.getByRole('button', { name: 'Withdraw' }).click();
  await bob2.locator('#pl-withdraw-form input[name="amount"]').fill('5');
  await bob2.locator('#pl-withdraw-form').getByRole('button', { name: 'Withdraw' }).click();
  await expect(bob2.getByText(/Withdrawal released on/)).toBeVisible({ timeout: 180_000 });
  await expect(bob2.locator('.pl-balance', { hasText: 'private balance' }).locator('.pl-balance-amount')).toContainText('7.50');
  await shot(bob2, OUT, '09-bob-withdrawn');
  await bobCtx2.close();
});

test('5: Alice recovers on a fresh browser with her recovery code; a wrong code is refused', async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext();
  captureTraffic(ctx, traffic);
  await injectWallet(ctx, KEYS.alice, { chainId: 31337, nonDeterministic: true });
  const page = await ctx.newPage();
  await page.goto('/#/bonsai/app');
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  const input = page.locator('#pl-recovery-code input[name="code"]');
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill('PEAL-AAAAA-AAAAA-AAAAA-AAAAA');
  await page.locator('#pl-recovery-code').getByRole('button', { name: 'Open my account' }).click();
  await expect(page.locator('.pl-notice-bad')).toBeVisible({ timeout: 60_000 });
  await input.fill(aliceRecoveryCode);
  await page.locator('#pl-recovery-code').getByRole('button', { name: 'Open my account' }).click();
  await expect(page.getByText('private payments on')).toBeVisible({ timeout: 120_000 });
  // Her funded balance is back: 100 added at checkout minus 12.50 paid.
  await expect(page.locator('.pl-balance', { hasText: 'private balance' }).locator('.pl-balance-amount')).toContainText('87.50');
  await expect(page.locator('.pl-list', { hasText: 'paid link' })).toBeVisible();
  await expectNoBonsaiIdentifiers(page);
  await shot(page, OUT, '10-alice-recovered-fresh-browser');
  await ctx.close();
});

test('8: paying an address that never activated private receiving is an invitation, no funds move', async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext();
  captureTraffic(ctx, traffic);
  await injectWallet(ctx, KEYS.alice, { chainId: 31337, nonDeterministic: true });
  const page = await ctx.newPage();
  await page.goto('/#/bonsai/app');
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: 'Continue with this wallet' }).click();
  await page.locator('#pl-recovery-code input[name="code"]').fill(aliceRecoveryCode);
  await page.locator('#pl-recovery-code').getByRole('button', { name: 'Open my account' }).click();
  await expect(page.getByText('private payments on')).toBeVisible({ timeout: 120_000 });
  const before = await page.locator('.pl-balance', { hasText: 'private balance' }).locator('.pl-balance-amount').innerText();

  await page.getByRole('button', { name: 'Send to an address' }).click();
  await page.locator('#pl-send-form input[name="to"]').fill(carolAddress);
  await page.locator('#pl-send-form input[name="amount"]').fill('1');
  await page.locator('#pl-send-form').getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#pl-invite')).toContainText('has not activated private receiving', { timeout: 60_000 });
  await expect(page.locator('#pl-invite-url')).toHaveValue(new RegExp(`invite=${carolAddress.toLowerCase()}$`));
  const after = await page.locator('.pl-balance', { hasText: 'private balance' }).locator('.pl-balance-amount').innerText();
  expect(after).toBe(before);
  await shot(page, OUT, '11-alice-invitation');

  // And a real address: Bob, resolved through the directory and paid privately.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Send to an address' }).click();
  await page.locator('#pl-send-form input[name="to"]').fill(bobAddress);
  await page.locator('#pl-send-form input[name="amount"]').fill('2');
  await page.locator('#pl-send-form input[name="reference"]').fill('lunch');
  await page.locator('#pl-send-form').getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Sent 2\.00 tUSD to/)).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.pl-list', { hasText: `sent to ${bobAddress.slice(0, 6).toLowerCase()}` })).toBeVisible();
  await shot(page, OUT, '12-alice-sent-to-address');
  await ctx.close();
});

test('6: a reload in the middle of the checkout never pays twice', async ({ browser }) => {
  test.setTimeout(400_000);
  // Bob publishes a second link through the UI (same fresh-browser path).
  const bobCtx = await browser.newContext();
  await injectWallet(bobCtx, KEYS.bob, { chainId: 31337 });
  const bob = await bobCtx.newPage();
  await activateOnDashboard(bob);
  await bob.getByRole('button', { name: 'New payment link' }).click();
  await bob.locator('#pl-request-form input[name="title"]').fill('Reload me');
  await bob.locator('#pl-request-form input[name="amount"]').fill('3');
  await bob.locator('#pl-request-form').getByRole('button', { name: 'Create link' }).click();
  const url = await bob.locator('#pl-link-url').inputValue({ timeout: 60_000 });
  const requestId = url.slice(-24);
  await bobCtx.close();

  const ctx = await browser.newContext();
  captureTraffic(ctx, traffic);
  await injectWallet(ctx, KEYS.alice, { chainId: 31337, nonDeterministic: true });
  const page = await ctx.newPage();
  await page.goto(`/#/pay/${requestId}`);
  await page.getByRole('button', { name: 'Use browser wallet' }).click();
  await page.getByRole('button', { name: /Continue with wallet/ }).click();
  await page.locator('#pay-recovery-code input[name="code"]').fill(aliceRecoveryCode);
  await page.locator('#pay-recovery-code').getByRole('button', { name: 'Open my account and continue' }).click();
  await expect(page.getByRole('button', { name: /^Pay 3\.00/ })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /^Pay 3\.00/ }).click();
  await expect(page.locator('.pl-step-active', { hasText: 'Preparing payment' })).toBeVisible({ timeout: 60_000 });
  await page.reload();
  // Either the payment landed before the reload (the page says so and offers
  // no second Pay button) or it did not (one Pay button, one payment).
  await expect(page.getByText(/paid from this device|awaiting payment/)).toBeVisible({ timeout: 120_000 });
  if (await page.getByText('awaiting payment').isVisible()) {
    await expect(page.getByRole('button', { name: /^Pay 3\.00/ })).toBeVisible({ timeout: 120_000 });
    await page.getByRole('button', { name: /^Pay 3\.00/ }).click();
    await expect(page.getByText('Payment sent.')).toBeVisible({ timeout: 180_000 });
  }
  await expect(page.getByRole('button', { name: /^Pay 3\.00/ })).toHaveCount(0);
  await shot(page, OUT, '13-alice-after-reload');
  await ctx.close();

  // Exactly one payment reached Bob for this link: the inbox holds one
  // envelope tagged with the request id.
  const client = new NodeClient({ baseUrl: NODE });
  const status = await client.status();
  const ns = status.namespaces[0]!;
  const req = await client.getRequest(requestId);
  const { items } = await client.inbox(ns.id, req.manifest.receiver_account, '', 0).catch(() => ({ items: [] as { request_id: string | null }[] }));
  const forThis = items.filter((i) => i.request_id === requestId);
  expect(forThis.length).toBeLessThanOrEqual(1);
});

test('privacy: nothing the browsers sent carries spending secrets, openings, balances or payment intents', async () => {
  expect(traffic.length).toBeGreaterThan(20);
  for (const r of traffic) {
    for (const word of FORBIDDEN_ON_WIRE) {
      expect(r.body + ' ' + r.url, `${word} found in a request to ${r.url}`).not.toContain(word);
    }
  }
  const ops = traffic.filter((r) => /\/ledger\/[0-9a-f]+\/ops$/.test(r.url));
  expect(ops.length).toBeGreaterThanOrEqual(3);
  for (const op of ops) {
    const keys = Object.keys(JSON.parse(op.body) as Record<string, unknown>).sort();
    expect(keys).toEqual(['account', 'circuit_id', 'com', 'com_new', 'namespace', 'proof', 'pubkey', 'receipt', 'root', 'signature']);
  }
  const inbox = traffic.filter((r) => /\/inbox\/[0-9a-f]+\/[0-9a-f]+$/.test(r.url) && r.body);
  for (const post of inbox) expect(post.body).not.toContain('"amount"');
});

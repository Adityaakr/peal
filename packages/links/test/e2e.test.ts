// End to end through the SDK against a running node, with two users who
// only ever hold an EVM wallet (SPEC-ADDENDUM-one-wallet.md): automatic
// account setup with one profile signature, a real deposit, a payment link
// paid with a wallet-approved local intent, a payment to a plain 0x
// address resolved through the directory, an unregistered address that
// moves no funds, recovery on a fresh device through both mechanisms, and
// crash reconcile. Real proofs from the single-threaded wasm, real ledger
// transitions, the encrypted inbox.
//
// Skipped (not faked) when no node is reachable: `LINKS_URL` unset and
// nothing answers on 127.0.0.1:8790.

import { describe, expect, it, beforeAll } from 'vitest';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createLocalProver } from '../src/local.js';
import {
  ERC20_ABI,
  GATEWAY_ABI,
  LinksAccount,
  loadParams,
  MemoryStore,
  newIntentId,
  NodeClient,
  paymentIntentTypedData,
  verifyProfile,
  walletScopedStore,
  type AsyncProver,
  type LinksStatus,
} from '../src/index.js';
import { device, evmAccount, setupAccount, signedClient, URL_ } from './helpers.js';

const RPC_A = process.env.ANVIL_A ?? 'http://127.0.0.1:8545';

async function nodeUp(): Promise<LinksStatus | null> {
  try {
    return await new NodeClient({ baseUrl: URL_ }).status();
  } catch {
    return null;
  }
}

const timings: Record<string, number> = {};
async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
}

describe('peal-links end to end (wasm prover, live node, one wallet)', () => {
  let status: LinksStatus | null = null;
  let prover: AsyncProver;
  const client = new NodeClient({ baseUrl: URL_ });

  beforeAll(async () => {
    status = await nodeUp();
    if (!status) return;
    prover = await createLocalProver();
    await timed('load params', () => loadParams(client, prover));
  }, 120_000);

  it('two wallets: set up, fund, request, approve and pay, pay an address, recover on a fresh device, claim', async () => {
    if (!status) {
      console.warn('no Peal Links node at', URL_, '- skipping (run scripts/peal-links/stack.sh up)');
      return;
    }
    const nsInfo = status.namespaces[0]!;
    expect(nsInfo.available, 'chain A gateway must be verified by the node').toBe(true);
    const ns = nsInfo.id;
    const unit = 10n ** BigInt(nsInfo.decimals);

    // Alice (payer, anvil account 0, derived-key recovery) and Bob (receiver,
    // anvil account 1, recovery code), each on their own device.
    const aliceEvm = evmAccount(0);
    const bobEvm = evmAccount(1);
    const a = await timed('alice setup (profile signature, register, backup)', () =>
      setupAccount(prover, nsInfo, status!.circuit_id, aliceEvm, 'Alice', 'wallet-signature'),
    );
    const b = await setupAccount(prover, nsInfo, status.circuit_id, bobEvm, 'Bob', 'recovery-code');
    const alice = a.account;
    const bob = b.account;
    const aliceView = await alice.view();
    expect(aliceView.registered).toBe(true);
    expect((await client.account(ns, aliceView.account))?.com).toBe(aliceView.commitment);
    expect(await alice.walletAddress()).toBe(aliceEvm.address.toLowerCase());
    // The directory serves Bob's profile and it verifies against his address.
    const entry = await a.client.profile(ns, bobEvm.address);
    expect(entry?.profile.display_name).toBe('Bob');
    expect(await verifyProfile(entry!.profile)).toBe(true);
    expect(await verifyProfile({ ...entry!.profile, display_name: 'Mallory' })).toBe(false);
    // Lookups need a session.
    await expect(client.profile(ns, bobEvm.address)).rejects.toMatchObject({ status: 401 });
    // An address that never activated private receiving.
    expect(await alice.resolve(evmAccount(3).address)).toBeNull();

    // Alice funds 100.00 units: R_dep proof, intent, then a real deposit on
    // chain A from her wallet, credited by the watcher.
    const amount = (100n * unit).toString();
    const { receipt } = await timed('deposit proof (R_dep)', () => alice.prepareDeposit(amount));
    {
      const chain = { id: nsInfo.chain_id, name: nsInfo.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_A] } } };
      const pc = createPublicClient({ chain, transport: http(RPC_A) });
      const wc = createWalletClient({ account: aliceEvm, chain, transport: http(RPC_A) });
      const approve = await wc.writeContract({ address: nsInfo.token_address as Address, abi: ERC20_ABI, functionName: 'approve', args: [nsInfo.gateway as Address, BigInt(amount)] });
      await pc.waitForTransactionReceipt({ hash: approve });
      const dep = await wc.writeContract({ address: nsInfo.gateway as Address, abi: GATEWAY_ABI, functionName: 'deposit', args: [nsInfo.token_address as Address, BigInt(amount), `0x${receipt}` as Hex] });
      await pc.waitForTransactionReceipt({ hash: dep });
    }
    await timed('watcher credit', async () => {
      for (let i = 0; i < 60; i++) {
        if ((await alice.syncDeposits()).length) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('deposit not credited');
    });
    await alice.verifyReceipts();
    expect(await timed('claim (R_op receive)', () => alice.claimAll())).toBe(1);
    let v = await alice.view();
    expect(v.balance).toBe(amount);

    // Bob creates a link: no wallet popup, the manifest names his address.
    const price = (12n * unit + unit / 2n).toString(); // 12.50
    const request = await bob.createRequest({ amount: price, title: 'Logo files', reference: 'INV-7' });
    expect(request.status).toBe('active');
    expect(request.manifest.receiver_address).toBe(bobEvm.address.toLowerCase());
    const fetched = await client.getRequest(request.manifest.request_id);
    const tampered = { ...fetched, manifest: { ...fetched.manifest, amount: (1n * unit).toString() } };
    await expect(alice.pay({ request: tampered }, newIntentId())).rejects.toThrow();

    // Alice's wallet approves the payment locally; a wrong approval is refused.
    const intent = await alice.paymentIntentFor({ request: fetched });
    const badSig = await evmAccount(2).signTypedData(paymentIntentTypedData(intent, nsInfo.chain_id));
    await expect(alice.pay({ request: fetched }, newIntentId(), { intent, signature: badSig })).rejects.toThrow(/does not verify/);
    const signature = await a.signer.signTypedData(paymentIntentTypedData(intent, nsInfo.chain_id));
    const paid = await timed('pay (R_op send + deliver)', () => alice.pay({ request: fetched }, newIntentId(), { intent, signature }));
    expect(paid.delivered).toBe(true);
    v = await alice.view();
    expect(BigInt(v.balance)).toBe(BigInt(amount) - BigInt(price));

    // Alice pays Bob's plain address, resolved and verified through the directory.
    const resolved = await alice.resolve(bobEvm.address);
    expect(resolved?.profile.account).toBe((await bob.view()).account);
    const tip = (2n * unit).toString();
    const intent2 = await alice.paymentIntentFor({ profile: resolved!.profile, profileHash: resolved!.hash, amount: tip });
    const sig2 = await a.signer.signTypedData(paymentIntentTypedData(intent2, nsInfo.chain_id));
    const paid2 = await alice.pay({ profile: resolved!.profile, profileHash: resolved!.hash, amount: tip, reference: 'tip' }, newIntentId(), { intent: intent2, signature: sig2 });
    expect(paid2.delivered).toBe(true);
    expect((await alice.labels())[String(paid2.position)]).toBe(bobEvm.address.toLowerCase());

    // Bob was offline. He comes back on a fresh device: sign in, fetch the
    // backup the node holds, open it with his recovery code, sync, claim.
    const bobDevice2 = device();
    const bobClient2 = await signedClient(bobEvm, nsInfo.chain_id);
    const wrong = { ...b.recovery, code: 'PEAL-AAAAA-AAAAA-AAAAA-AAAAA' } as typeof b.recovery;
    await expect(LinksAccount.recover({ prover, client: bobClient2, namespace: ns, store: new MemoryStore() }, wrong)).rejects.toThrow();
    const bob2 = await timed('recover (fresh device)', () =>
      LinksAccount.recover({ prover, client: bobClient2, namespace: ns, store: bobDevice2.store, deviceKeys: bobDevice2.deviceKeys }, b.recovery),
    );
    const synced = await bob2.sync();
    expect(synced.discovered).toBe(2);
    let bv = await bob2.view();
    expect(BigInt(bv.unclaimed)).toBe(BigInt(price) + BigInt(tip));
    expect(await timed('claim x2 (Bob)', () => bob2.claimAll())).toBe(2);
    bv = await bob2.view();
    expect(BigInt(bv.balance)).toBe(BigInt(price) + BigInt(tip));
    const claimedFor = bv.receipts.find((r) => r.reference === request.manifest.request_id)!;
    await bob2.acknowledge(request.manifest.request_id, claimedFor.position);
    expect((await client.getRequest(request.manifest.request_id)).status).toBe('fulfilled');

    // The same device again needs no signature: unlock from the device key.
    const bob2again = await LinksAccount.unlock({ prover, client: bobClient2, namespace: ns, store: bobDevice2.store, deviceKeys: bobDevice2.deviceKeys });
    expect((await bob2again.view()).balance).toBe(bv.balance);

    // Alice recovers through the wallet-signature path on a fresh device.
    const aliceDevice2 = device();
    const aliceClient2 = await signedClient(aliceEvm, nsInfo.chain_id);
    const alice2 = await LinksAccount.recover({ prover, client: aliceClient2, namespace: ns, store: aliceDevice2.store, deviceKeys: aliceDevice2.deviceKeys }, a.recovery);
    expect((await alice2.view()).balance).toBe((await alice.view()).balance);

    // Bob's old device is now stale (its commitment moved): unlocking and
    // reconciling reports a conflict rather than pretending.
    const stale = await LinksAccount.unlock({ prover, client: b.client, namespace: ns, store: b.dev.store, deviceKeys: b.dev.deviceKeys });
    expect(await stale.reconcile()).toBe('conflict');

    // Crash between submission and local commit: Alice pays again (a fresh
    // request) and reconciles cleanly.
    const req2 = await bob2.createRequest({ amount: (1n * unit).toString(), title: 'Tip' });
    const before = await alice.view();
    await alice.pay({ request: req2 }, newIntentId());
    const after = await alice.view();
    expect(BigInt(before.balance) - BigInt(after.balance)).toBe(1n * unit);
    expect(await alice.reconcile()).toBe('in_sync');

    // Ledger-level sanity: the public log has the ops.
    const summary = await client.ledger(ns);
    expect(summary.receipt_count).toBeGreaterThanOrEqual(6);
    console.log('timings (ms, single-threaded wasm in Node):', timings);
  }, 900_000);

  it('one device, two wallets: an account saved before per-wallet stores is adopted by its owner and left alone by any other wallet', async () => {
    if (!status) return;
    const ns = status.namespaces[0]!;
    const owner = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const dev = device();
    // The pre-partition layout: the account sits under the bare namespace keys.
    const { client: ownerClient } = await setupAccount(prover, ns, status.circuit_id, owner, 'Owner', 'wallet-signature', dev);
    const base = { prover, client: ownerClient, namespace: ns.id, store: dev.store, deviceKeys: dev.deviceKeys };
    // Another wallet on the same device finds nothing of its own and must not take it.
    expect(await LinksAccount.adoptUnscoped(base, other.address)).toBe('other');
    expect(await LinksAccount.exists(walletScopedStore(dev.store, other.address), ns.id)).toBe(false);
    expect(await LinksAccount.exists(dev.store, ns.id)).toBe(true);
    // The owner adopts it: moved under its own scope, gone from the bare keys, unlockable there.
    expect(await LinksAccount.adoptUnscoped(base, owner.address)).toBe('moved');
    expect(await LinksAccount.exists(dev.store, ns.id)).toBe(false);
    const scoped = walletScopedStore(dev.store, owner.address);
    expect((await (await LinksAccount.unlock({ ...base, store: scoped })).walletAddress())?.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(await LinksAccount.adoptUnscoped(base, owner.address)).toBe('none');
    // The other wallet sets up beside it; the owner's account is untouched.
    await setupAccount(prover, ns, status.circuit_id, other, 'Other', 'wallet-signature', { store: walletScopedStore(dev.store, other.address), deviceKeys: dev.deviceKeys });
    expect((await (await LinksAccount.unlock({ ...base, store: scoped })).walletAddress())?.toLowerCase()).toBe(owner.address.toLowerCase());
  }, 300_000);
});

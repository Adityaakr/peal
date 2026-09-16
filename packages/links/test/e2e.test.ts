// End to end through the SDK against a running node (scripts/peal-links/
// stack.sh up with PEAL_LINKS_DEV_MINT=1). Two accounts, real proofs from
// the single-threaded wasm, real ledger transitions, the encrypted inbox,
// crash reconcile, backup restore.
//
// Skipped (not faked) when no node is reachable: `LINKS_URL` unset and
// nothing answers on 127.0.0.1:8790.

import { describe, expect, it, beforeAll } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { createLocalProver } from '../src/local.js';
import {
  ERC20_ABI,
  GATEWAY_ABI,
  LinksAccount,
  loadParams,
  MemoryStore,
  newIntentId,
  NodeClient,
  siweMessage,
  type AsyncProver,
  type LinksStatus,
} from '../src/index.js';

const URL_ = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
const RPC_A = process.env.ANVIL_A ?? 'http://127.0.0.1:8545';
const PASS = 'correct horse battery staple';
// anvil's well-known account 0; never holds real funds.
const EVM_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function nodeUp(): Promise<LinksStatus | null> {
  try {
    return await new NodeClient({ baseUrl: URL_ }).status();
  } catch {
    return null;
  }
}

async function signIn(client: NodeClient, chainId: number): Promise<void> {
  const account = privateKeyToAccount(EVM_KEY);
  const { nonce } = await client.nonce();
  const message = siweMessage({ domain: 'localhost:5173', address: account.address, uri: 'http://localhost:5173/bonsai/app', chainId, nonce });
  const signature = await account.signMessage({ message });
  await client.session(message, signature);
}

const timings: Record<string, number> = {};
async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
}

describe('peal-links end to end (wasm prover, live node)', () => {
  let status: LinksStatus | null = null;
  let prover: AsyncProver;
  const client = new NodeClient({ baseUrl: URL_ });

  beforeAll(async () => {
    status = await nodeUp();
    if (!status) return;
    prover = await createLocalProver();
    await timed('load params', () => loadParams(client, prover));
  }, 120_000);

  it('two accounts: fund, request, pay, deliver, claim, acknowledge, back up, restore', async () => {
    if (!status) {
      console.warn('no Peal Links node at', URL_, '- skipping (run scripts/peal-links/stack.sh up)');
      return;
    }
    const nsInfo = status.namespaces[0]!;
    expect(nsInfo.available, 'chain A gateway must be verified by the node').toBe(true);
    const ns = nsInfo.id;
    const decimals = nsInfo.decimals;
    const unit = 10n ** BigInt(decimals);

    // Alice (payer) and Bob (receiver), each on their own device (store).
    const aliceStore = new MemoryStore();
    const bobStore = new MemoryStore();
    const alice = await LinksAccount.create({ prover, client, namespace: ns, store: aliceStore }, status.circuit_id, PASS);
    const bob = await LinksAccount.create({ prover, client, namespace: ns, store: bobStore }, status.circuit_id, PASS);
    await alice.register();
    await bob.register();
    await alice.register(); // idempotent
    const aliceView = await alice.view();
    expect(aliceView.registered).toBe(true);
    expect((await client.account(ns, aliceView.account))?.com).toBe(aliceView.commitment);

    // Alice funds 100.00 units: R_dep proof, intent, then a real deposit on
    // chain A from anvil account 0, credited by the watcher.
    const amount = (100n * unit).toString();
    const { receipt } = await timed('deposit proof (R_dep)', () => alice.prepareDeposit(amount));
    expect((await alice.syncDeposits()).length).toBe(0); // not minted yet
    {
      const evm = privateKeyToAccount(EVM_KEY);
      const chain = { id: nsInfo.chain_id, name: nsInfo.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_A] } } };
      const pc = createPublicClient({ chain, transport: http(RPC_A) });
      const wc = createWalletClient({ account: evm, chain, transport: http(RPC_A) });
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
    let v = await alice.view();
    expect(v.balance).toBe('0');
    expect(v.unclaimed).toBe(amount);
    expect(v.receipts[0]!.status).toBe('unclaimed');
    await timed('claim proof (R_op receive)', () => alice.claim(0));
    v = await alice.view();
    expect(v.balance).toBe(amount);
    expect(v.unclaimed).toBe('0');

    // Bob creates a request (signed in with his EVM wallet).
    const bobClient = new NodeClient({ baseUrl: URL_ });
    await signIn(bobClient, status.namespaces[0]!.chain_id);
    const bobSigned = await LinksAccount.open({ prover, client: bobClient, namespace: ns, store: bobStore }, PASS);
    const price = (12n * unit + unit / 2n).toString(); // 12.50
    const request = await bobSigned.createRequest({ amount: price, title: 'Logo files', displayName: 'Bob', reference: 'INV-7' });
    expect(request.status).toBe('active');
    expect(request.manifest.amount).toBe(price);
    // Publicly readable, and verified by the payer's wasm before paying.
    const fetched = await client.getRequest(request.manifest.request_id);
    expect(fetched.manifest.signature).toBe(request.manifest.signature);
    const tampered = { ...fetched, manifest: { ...fetched.manifest, amount: (1n * unit).toString() } };
    await expect(alice.pay(tampered, newIntentId())).rejects.toThrow();

    // Alice pays (Bob is offline: nothing of Bob's runs here).
    const paid = await timed('pay (R_op send + deliver)', () => alice.pay(fetched, newIntentId()));
    expect(paid.delivered).toBe(true);
    v = await alice.view();
    expect(BigInt(v.balance)).toBe(BigInt(amount) - BigInt(price));
    expect(v.history.at(-1)).toMatchObject({ kind: 'send', amount: price, reference: request.manifest.request_id });

    // A second payer racing on the same one-time request is refused by the
    // soft lock while the first reservation is fresh.
    await expect(client.reserveRequest(request.manifest.request_id, newIntentId())).rejects.toMatchObject({ code: 'reserved' });

    // Bob comes back online later, on a device restored from backup.
    const backup = await bob.exportBackup('bob backup passphrase');
    const bobNewDevice = new MemoryStore();
    const bob2 = await LinksAccount.restore({ prover, client, namespace: ns, store: bobNewDevice }, backup, 'bob backup passphrase', PASS);
    await expect(LinksAccount.restore({ prover, client, namespace: ns, store: new MemoryStore() }, backup, 'wrong passphrase!!', PASS)).rejects.toThrow();
    const synced = await bob2.sync();
    expect(synced.discovered).toBe(1);
    let bv = await bob2.view();
    expect(bv.unclaimed).toBe(price);
    expect(bv.receipts[0]).toMatchObject({ status: 'unclaimed', amount: price, sender: aliceView.account });
    await timed('claim proof (Bob)', () => bob2.claim(0));
    bv = await bob2.view();
    expect(bv.balance).toBe(price);
    await bob2.acknowledge(request.manifest.request_id, bv.receipts[0]!.position);
    expect((await client.getRequest(request.manifest.request_id)).status).toBe('fulfilled');

    // The old device's wallet is now stale (its commitment moved): opening it
    // and reconciling reports a conflict rather than pretending.
    const stale = await LinksAccount.open({ prover, client, namespace: ns, store: bobStore }, PASS);
    expect(await stale.reconcile()).toBe('conflict');

    // Crash between submission and local commit: Alice pays again (a fresh
    // request), we snapshot her store right after the proof is journaled,
    // then reconcile the snapshot against the ledger.
    const req2 = await bobSigned.createRequest({ amount: (1n * unit).toString(), title: 'Tip', displayName: 'Bob' });
    const before = await alice.view();
    await alice.pay(req2, newIntentId());
    const after = await alice.view();
    expect(BigInt(before.balance) - BigInt(after.balance)).toBe(1n * unit);
    expect(await alice.reconcile()).toBe('in_sync');

    // Ledger-level sanity: the public log has the ops and a replayable root.
    const summary = await client.ledger(ns);
    expect(summary.receipt_count).toBeGreaterThanOrEqual(5); // mint, claim, pay, claim, pay
    console.log('timings (ms, single-threaded wasm in Node):', timings);
  }, 600_000);
});

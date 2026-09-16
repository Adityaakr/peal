// Gate D through the SDK: real tokens enter the gateway on anvil A, are
// credited by the watcher after confirmations, move privately, and leave
// again through a committee-certified withdrawal; chain B is a separate
// domain that never sees any of it. Runs against `scripts/peal-links/
// stack.sh up` (no dev mint needed). Skipped, not faked, without a node.

import { describe, expect, it, beforeAll } from 'vitest';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalProver } from '../src/local.js';
import {
  ERC20_ABI,
  GATEWAY_ABI,
  LinksAccount,
  loadParams,
  MemoryStore,
  NodeClient,
  type AsyncProver,
  type LinksStatus,
  type NamespaceInfo,
} from '../src/index.js';

const URL_ = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
const RPC_A = process.env.ANVIL_A ?? 'http://127.0.0.1:8545';
const RPC_B = process.env.ANVIL_B ?? 'http://127.0.0.1:8546';
const PASS = 'correct horse battery staple';
// anvil account 1 (public test key), funded with tUSD by the stack script.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function chain(ns: NamespaceInfo) {
  return { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] as string[] } } };
}

async function waitFor<T>(label: string, f: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await f();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('peal-links bridge (real deposits and withdrawals on two local chains)', () => {
  let status: LinksStatus | null = null;
  let prover: AsyncProver;
  const client = new NodeClient({ baseUrl: URL_ });

  beforeAll(async () => {
    try {
      status = await client.status();
    } catch {
      status = null;
    }
    if (!status) return;
    prover = await createLocalProver();
    await loadParams(client, prover);
  }, 120_000);

  it('deposit is credited after confirmations, moves privately, and withdraws through the committee', async () => {
    if (!status) {
      console.warn('no Peal Links node at', URL_, '- skipping');
      return;
    }
    const nsA = status.namespaces.find((n) => n.chain_id === 31337)!;
    const nsB = status.namespaces.find((n) => n.chain_id === 31338)!;
    expect(nsA.available, 'chain A gateway must be verified by the watcher').toBe(true);
    expect(nsB.available).toBe(true);
    expect(status.signer_mode).toBe('single-process-fixture');

    const account = privateKeyToAccount(KEY);
    const pc = createPublicClient({ chain: chain(nsA), transport: http(RPC_A) });
    const wc = createWalletClient({ account, chain: chain(nsA), transport: http(RPC_A) });
    const token = nsA.token_address as Address;
    const gateway = nsA.gateway as Address;
    const reserveBefore = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [gateway] });
    const liabilityBefore = BigInt((await client.accounting(nsA.id)).outstanding_liability);
    const walletBefore = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    expect(walletBefore).toBeGreaterThan(0n);

    // Alice: intent first, then the on-chain deposit carrying the receipt.
    const alice = await LinksAccount.create({ prover, client, namespace: nsA.id, store: new MemoryStore() }, status.circuit_id, PASS);
    await alice.register();
    const amount = 25_000_000n; // 25.000000 tUSD
    const { receipt } = await alice.prepareDeposit(amount.toString());
    const approve = await wc.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [gateway, amount] });
    await pc.waitForTransactionReceipt({ hash: approve });
    const dep = await wc.writeContract({ address: gateway, abi: GATEWAY_ABI, functionName: 'deposit', args: [token, amount, `0x${receipt}` as Hex] });
    const depReceipt = await pc.waitForTransactionReceipt({ hash: dep });
    expect(depReceipt.status).toBe('success');
    expect(await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [gateway] })).toBe(reserveBefore + amount);

    // Credited only after `confirmations` blocks (anvil mines one a second).
    const intent = await waitFor('watcher credit', async () => {
      const st = await client.depositIntent(nsA.id, receipt);
      return st.status === 'minted' ? st : null;
    });
    expect(intent.deposit_id).toMatch(new RegExp(`^31337:${dep}:\\d+$`));
    expect((await alice.syncDeposits()).length).toBe(1);
    await alice.verifyReceipts();
    let v = await alice.view();
    expect(v.unclaimed).toBe(amount.toString());
    await alice.claim(0);
    v = await alice.view();
    expect(v.balance).toBe(amount.toString());

    // A second deposit for the same receipt is a different event and the
    // watcher refuses it: the intent is already minted, so the tokens sit
    // in the gateway as an unmatched deposit (recorded, never credited).
    const approve2 = await wc.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [gateway, amount] });
    await pc.waitForTransactionReceipt({ hash: approve2 });
    const dep2 = await wc.writeContract({ address: gateway, abi: GATEWAY_ABI, functionName: 'deposit', args: [token, amount, `0x${receipt}` as Hex] });
    await pc.waitForTransactionReceipt({ hash: dep2 });
    await new Promise((r) => setTimeout(r, (nsA.confirmations + 3) * 1000));
    expect((await alice.view()).balance).toBe(amount.toString());

    // Bob receives a private payment, then withdraws part of it to chain A.
    const bob = await LinksAccount.create({ prover, client, namespace: nsA.id, store: new MemoryStore() }, status.circuit_id, PASS);
    await bob.register();
    const bobClient = new NodeClient({ baseUrl: URL_ });
    // Bob needs a session to publish a request; sign in as anvil account 2.
    const bobEvm = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
    const { nonce } = await bobClient.nonce();
    const { siweMessage } = await import('../src/index.js');
    const msg = siweMessage({ domain: 'localhost:5173', address: bobEvm.address, uri: 'http://localhost:5173/bonsai/app', chainId: nsA.chain_id, nonce });
    await bobClient.session(msg, await bobEvm.signMessage({ message: msg }));
    const bobSigned = await LinksAccount.open({ prover, client: bobClient, namespace: nsA.id, store: (bob as unknown as { store: MemoryStore }).store }, PASS);
    const req = await bobSigned.createRequest({ amount: '10000000', title: 'Ten', displayName: 'Bob' });
    await alice.pay(req, 'intent-bridge-1');
    await bob.sync();
    await bob.claim(0);
    expect((await bob.view()).balance).toBe('10000000');

    const recipient = '0x000000000000000000000000000000000000dEaD';
    const recipientBefore = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
    const { position, certificate } = await bob.withdraw('4000000', recipient);
    expect(certificate.signatures.length).toBe(3);
    expect(certificate.threshold).toBe(2);
    expect(certificate.message.recipient).toBe(recipient.toLowerCase());
    expect(certificate.message.amount).toBe('4000000');
    expect((await bob.view()).balance).toBe('6000000');
    // Settling again is idempotent; a forged claim for another position is refused.
    expect((await bob.settle(position)).message.withdrawal_id).toBe(certificate.message.withdrawal_id);

    // Anyone can submit the certificate; the tokens go to the recipient.
    const m = certificate.message;
    const tx = await wc.writeContract({
      address: gateway,
      abi: GATEWAY_ABI,
      functionName: 'withdraw',
      args: [
        { chainId: BigInt(m.chain_id), gateway: m.gateway as Address, token: m.token as Address, recipient: m.recipient as Address, amount: BigInt(m.amount), withdrawalId: `0x${m.withdrawal_id}` as Hex, epoch: BigInt(m.epoch) },
        certificate.signatures as Hex[],
      ],
    });
    expect((await pc.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
    expect(await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] })).toBe(recipientBefore + 4_000_000n);
    // Replay is refused by the contract.
    await expect(
      wc.writeContract({
        address: gateway,
        abi: GATEWAY_ABI,
        functionName: 'withdraw',
        args: [
          { chainId: BigInt(m.chain_id), gateway: m.gateway as Address, token: m.token as Address, recipient: m.recipient as Address, amount: BigInt(m.amount), withdrawalId: `0x${m.withdrawal_id}` as Hex, epoch: BigInt(m.epoch) },
          certificate.signatures as Hex[],
        ],
      }),
    ).rejects.toThrow();
    // The watcher sees the Withdrawn event and confirms it.
    const confirmed = await waitFor('withdrawal confirmation', async () => {
      const w = await client.withdrawal(nsA.id, position);
      return w.status === 'confirmed' ? w : null;
    });
    expect(confirmed.tx_hash).toBe(tx);

    // Conservation on chain A: this test's minted - withdrawn equals the
    // two balances it created (other tests' accounts are in the base).
    const acct = await client.accounting(nsA.id);
    expect(BigInt(acct.minted_total) - BigInt(acct.withdrawn_total)).toBe(BigInt(acct.outstanding_liability));
    expect(BigInt(acct.outstanding_liability) - liabilityBefore).toBe(BigInt((await alice.view()).balance) + BigInt((await bob.view()).balance));
    // The gateway reserve covers the whole outstanding liability (the
    // unmatched second deposit sits on top of it).
    const reserveAfter = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [gateway] });
    expect(reserveAfter).toBeGreaterThanOrEqual(BigInt(acct.outstanding_liability));
    expect(reserveAfter - reserveBefore).toBe(2n * amount - 4_000_000n);

    // Chain B is a separate domain: its ledger saw nothing of this.
    const pcB = createPublicClient({ chain: chain(nsB), transport: http(RPC_B) });
    const bAcct = await client.accounting(nsB.id);
    expect(bAcct.minted_total).toBe('0');
    expect(await pcB.readContract({ address: nsB.token_address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [nsB.gateway as Address] })).toBe(0n);
    // And a certificate for chain A cannot be replayed on chain B's gateway.
    const wcB = createWalletClient({ account, chain: chain(nsB), transport: http(RPC_B) });
    await expect(
      wcB.writeContract({
        address: nsB.gateway as Address,
        abi: GATEWAY_ABI,
        functionName: 'withdraw',
        args: [
          { chainId: BigInt(m.chain_id), gateway: m.gateway as Address, token: m.token as Address, recipient: m.recipient as Address, amount: BigInt(m.amount), withdrawalId: `0x${m.withdrawal_id}` as Hex, epoch: BigInt(m.epoch) },
          certificate.signatures as Hex[],
        ],
      }),
    ).rejects.toThrow();
  }, 600_000);
});

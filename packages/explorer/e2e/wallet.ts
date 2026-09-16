// A browser wallet for the Playwright suites: an EIP-1193 provider injected
// as `window.ethereum`, backed by a viem local account in the test process
// (anvil's public test keys, never real funds). Signs messages, typed data
// (EIP-712) and transactions like an extension would; everything else goes
// to the chain. `nonDeterministic` makes `personal_sign` return a different
// valid signature each time (ECDSA malleability), standing in for wallets
// that do not sign deterministically so the recovery-code path is exercised.
import type { BrowserContext, Page } from '@playwright/test';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ERC20_ABI, NodeClient } from 'peal-links';

export const NODE = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
export const RPC_BY_CHAIN: Record<number, string> = { 31337: 'http://127.0.0.1:8545', 31338: 'http://127.0.0.1:8546' };
export const KEYS = {
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // anvil 2
  alice: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // anvil 3
  carol: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // anvil 4
} as const;

export interface WalletOpts {
  chainId: number;
  rejectSign?: boolean;
  rejectTx?: boolean;
  nonDeterministic?: boolean;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The other valid ECDSA signature for the same message: s' = n - s, v flipped. */
function malleate(sig: Hex): Hex {
  const raw = sig.slice(2);
  const r = raw.slice(0, 64);
  const s = BigInt(`0x${raw.slice(64, 128)}`);
  const v = parseInt(raw.slice(128, 130), 16);
  const s2 = (N - s).toString(16).padStart(64, '0');
  const v2 = v === 27 ? 28 : 27;
  return `0x${r}${s2}${v2.toString(16).padStart(2, '0')}`;
}

/** Coerce a JSON-RPC typed-data payload (numbers as strings) into what
 * viem's `signTypedData` expects (bigint for integer types). */
function coerceTypedData(json: string) {
  const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  const fix = (typeName: string, value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of td.types[typeName] ?? []) {
      const v = value[f.name];
      out[f.name] = /^u?int/.test(f.type) && typeof v === 'string' ? BigInt(v) : v;
    }
    return out;
  };
  const domain = { ...td.domain } as Record<string, unknown>;
  if (typeof domain.chainId === 'string') domain.chainId = Number(domain.chainId);
  const { EIP712Domain: _drop, ...types } = td.types;
  return { domain, types, primaryType: td.primaryType, message: fix(td.primaryType, td.message) };
}

export async function injectWallet(context: BrowserContext, key: `0x${string}`, opts: WalletOpts): Promise<string> {
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[opts.chainId] ?? 'http://127.0.0.1:8545';
  const chain = { id: opts.chainId, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  let flip = false;
  await context.exposeFunction('__pealSign', async (hex: string) => {
    if (opts.rejectSign) throw new Error('User rejected the request.');
    const sig = await account.signMessage({ message: { raw: Buffer.from(hex.replace(/^0x/, ''), 'hex') } });
    if (!opts.nonDeterministic) return sig;
    flip = !flip;
    return flip ? malleate(sig) : sig;
  });
  await context.exposeFunction('__pealSignTyped', async (json: string) => {
    if (opts.rejectSign) throw new Error('User rejected the request.');
    const td = coerceTypedData(json);
    return account.signTypedData(td as Parameters<typeof account.signTypedData>[0]);
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
        isPealTestWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const w = window as unknown as {
            __pealSign: (h: string) => Promise<string>;
            __pealSignTyped: (j: string) => Promise<string>;
            __pealSendTx: (t: unknown) => Promise<string>;
            __pealRpc: (m: string, p: unknown[]) => Promise<unknown>;
          };
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
          if (method === 'eth_chainId') return chainHex;
          if (method === 'personal_sign') return w.__pealSign((params as string[])[0]!);
          if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
            const [, data] = params as [string, string | object];
            return w.__pealSignTyped(typeof data === 'string' ? data : JSON.stringify(data));
          }
          if (method === 'eth_sendTransaction') return w.__pealSendTx((params as unknown[])[0]);
          if (method === 'wallet_switchEthereumChain') return null;
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

export async function fundFromFaucet(key: `0x${string}`, amount = 1_000_000_000n): Promise<void> {
  const client = new NodeClient({ baseUrl: NODE });
  const ns = (await client.status()).namespaces[0]!;
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[ns.chain_id]!;
  const chain = { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wc = createWalletClient({ account, chain, transport: http(rpc) });
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const hash = await wc.writeContract({ address: ns.token_address as `0x${string}`, abi: ERC20_ABI, functionName: 'faucet', args: [account.address, amount] });
  await pc.waitForTransactionReceipt({ hash });
}

export async function shot(page: Page, dir: string, name: string): Promise<void> {
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Every request body and URL a context sends to the node, for privacy assertions. */
export function captureTraffic(context: BrowserContext, sink: Array<{ url: string; body: string }>): void {
  context.on('request', (r) => {
    if (r.url().includes('/links/v1/')) sink.push({ url: r.url(), body: r.postData() ?? '' });
  });
}

/** Words that must never appear in anything the browser sends. */
export const FORBIDDEN_ON_WIRE = [
  'spend_seed',
  'enc_seed',
  '"balance"',
  '"claimed"',
  'pending_deposits',
  'sent_openings',
  'passphrase',
  'recovery_code',
  'recipient_profile_hash', // the local payment intent
  'account_state_version',
  'PEAL-', // a recovery code
];

// A browser wallet for the Playwright suites: an EIP-1193 provider injected
// as `window.ethereum`, backed by a viem local account in the test process
// (anvil's public test keys, never real funds). Signs messages, typed data
// (EIP-712) and transactions like an extension would; everything else goes
// to the chain. `nonDeterministic` makes `personal_sign` draw a fresh nonce
// per signature, standing in for wallets that do not sign deterministically
// so the recovery-code path is exercised.
import type { BrowserContext, Page } from '@playwright/test';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount, setSignEntropy } from 'viem/accounts';
import { ensureGas, ERC20_ABI, NodeClient, TX_GAS } from 'peal-links';

// Deterministic nonces (RFC 6979 with fixed extra data) for every wallet in
// this process, from the start, so a deterministic test wallet signs the
// same bytes before and after a non-deterministic one has been used.
setSignEntropy(`0x${'00'.repeat(32)}`);

export const NODE = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';
export const RPC_BY_CHAIN: Record<number, string> = {
  31337: 'http://127.0.0.1:8545',
  31338: 'http://127.0.0.1:8546',
  11155111: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  42431: process.env.TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz',
};
/** Pays gas for fresh test wallets: anvil's account 0 locally, or the key in
 * `FUNDER_KEY` on a public testnet (a testnet deployer, never real funds). */
const FUNDER_KEY = (process.env.FUNDER_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
const GAS_GRANT = BigInt(process.env.GAS_GRANT_WEI ?? (process.env.FUNDER_KEY ? '3000000000000000' : '1000000000000000000'));
// Wallets the browser suites own (the SDK suites use anvil 0 to 3 and the
// settlement fixture uses 5 to 7), so a profile published by another suite
// never changes what a test sees.
export const KEYS = {
  bob: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // anvil 8
  alice: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // anvil 9
  carol: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // anvil 4, never activates
} as const;

export interface WalletOpts {
  chainId: number;
  rejectSign?: boolean;
  rejectTx?: boolean;
  nonDeterministic?: boolean;
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
  await context.exposeFunction('__pealSign', async (hex: string) => {
    if (opts.rejectSign) throw new Error('User rejected the request.');
    // A non-deterministic signer draws a fresh nonce per signature (viem's
    // extra entropy): every signature is valid and low-s, and no two are
    // the same, which is what the recovery-key check must detect.
    if (opts.nonDeterministic) setSignEntropy(true);
    try {
      return await account.signMessage({ message: { raw: Buffer.from(hex.replace(/^0x/, ''), 'hex') } });
    } finally {
      // Back to deterministic nonces (RFC 6979 with fixed extra data) for
      // every other wallet in this process.
      if (opts.nonDeterministic) setSignEntropy(`0x${'00'.repeat(32)}`);
    }
  });
  await context.exposeFunction('__pealSignTyped', async (json: string) => {
    if (opts.rejectSign) throw new Error('User rejected the request.');
    const td = coerceTypedData(json);
    return account.signTypedData(td as Parameters<typeof account.signTypedData>[0]);
  });
  await context.exposeFunction('__pealSendTx', async (tx: { to?: string; data?: string; value?: string; gas?: string }) => {
    if (opts.rejectTx) throw new Error('User rejected the request.');
    return wallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : TX_GAS[opts.chainId] });
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
          if (method === 'wallet_switchEthereumChain') {
            // A wallet that stays where it is: switching to another chain
            // is refused like a user declining the prompt.
            const wanted = (params as [{ chainId?: string }])[0]?.chainId;
            if (wanted && wanted.toLowerCase() !== chainHex.toLowerCase()) throw new Error('User rejected the request.');
            return null;
          }
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

/** A brand-new wallet for one run: a random key, gas from anvil's account 0
 * and test tokens from the faucet, so a run never depends on what an
 * earlier run published for a shared key. */
export async function freshWallet(tokens = 1_000_000_000n): Promise<`0x${string}`> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  const client = new NodeClient({ baseUrl: NODE });
  const ns = (await client.status()).namespaces[0]!;
  const rpc = RPC_BY_CHAIN[ns.chain_id]!;
  const chain = { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const funder = privateKeyToAccount(FUNDER_KEY);
  const wc = createWalletClient({ account: funder, chain, transport: http(rpc) });
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const to = privateKeyToAccount(key).address;
  // Chains with a gas faucet hand gas out themselves; the rest get a grant.
  if (!(await ensureGas(ns, to))) {
    const gas = await wc.sendTransaction({ to, value: GAS_GRANT });
    await pc.waitForTransactionReceipt({ hash: gas });
  }
  if (tokens > 0n) await fundFromFaucet(key, tokens);
  return key;
}

export async function fundFromFaucet(key: `0x${string}`, amount = 1_000_000_000n): Promise<void> {
  const client = new NodeClient({ baseUrl: NODE });
  const ns = (await client.status()).namespaces[0]!;
  const account = privateKeyToAccount(key);
  const rpc = RPC_BY_CHAIN[ns.chain_id]!;
  const chain = { id: ns.chain_id, name: ns.chain_name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wc = createWalletClient({ account, chain, transport: http(rpc) });
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const hash = await wc.writeContract({ address: ns.token_address as `0x${string}`, abi: ERC20_ABI, functionName: 'faucet', args: [account.address, amount], gas: TX_GAS[ns.chain_id] });
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

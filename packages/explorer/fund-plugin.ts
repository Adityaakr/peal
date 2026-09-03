/** Dev-only auto-funding.
 *
 * A new user on Tempo has no PathUSD, and PathUSD is the gas token, so they
 * cannot send a single transaction until someone gives them some. On a chain
 * with a native gas token the
 * same is true of ETH. Sign-in therefore has to be followed by funding or the
 * account is decorative.
 *
 * ## Why this is a server and not a page
 *
 * Funding means spending from a key that holds value. A key in the browser is a
 * key every visitor has, so this cannot be done client-side at any level of
 * cleverness. It runs as Vite middleware in development, and the same handler
 * should be a real service in production, behind whatever rate limiting the
 * deployment wants.
 *
 * ## What stops it being drained
 *
 * One grant per address, tracked in memory, plus fixed amounts. That is enough
 * for a dev server and is not enough for anything public: an attacker with
 * fresh addresses drains it, and restarting the server forgets who was funded.
 * Both limits are stated rather than hidden, and the production version needs
 * real per-identity limits tied to the Privy user id rather than the wallet.
 */
import type { Plugin } from 'vite';
import { createWalletClient, createPublicClient, http, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface ChainCfg {
  chainId: number;
  rpcUrl: string;
  /** Gas token. On Tempo this is an ERC-20 rather than a native balance. */
  gas: { kind: 'native'; amount: bigint } | { kind: 'erc20'; token: Address; amount: bigint };
  /** The auction payment token, so a funded user can actually bid. */
  quoteToken: Address;
  quoteAmount: bigint;
  /** The sale token, so a funded user can actually CREATE an auction.
   *
   * Missing this is not a smaller omission than missing gas. Creating an
   * auction pulls the full sale supply from the issuer, so an account with
   * gas and payment tokens but no sale token can browse and bid and then
   * fails on create with a bare revert. */
  saleToken: Address;
  saleAmount: bigint;
}

const CHAINS: Record<number, ChainCfg> = {
  42431: {
    chainId: 42431,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    // PathUSD, 6 decimals, and it is what gas is charged in.
    gas: { kind: 'erc20', token: '0x20c0000000000000000000000000000000000000', amount: parseUnits('50', 6) },
    quoteToken: '0x94521876dbE846a1a3eccF6636c2ec8E0BE82091',
    quoteAmount: parseUnits('1000', 18),
    saleToken: '0xdB1c20cF990Cd94c4806Aed7974Da8d4103A09b9',
    saleAmount: parseUnits('2000000', 18),
  },
};

const ERC20 = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const funded = new Set<string>();

/** Find the deployer key by walking up from this file.
 *
 * Vite's cwd is the package directory, not the repo root, so a relative path
 * finds nothing. Walking up is also what makes this work regardless of where
 * the dev server is started from. */
function key(): `0x${string}` {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.secrets', 'hoodi-deployer.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const w = Array.isArray(raw) ? raw[0] : raw;
      return w.private_key as `0x${string}`;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('.secrets/hoodi-deployer.json not found in any parent directory');
}

export function fundPlugin(): Plugin {
  return {
    name: 'peal-fund',
    configureServer(server) {
      server.middlewares.use('/api/fund', async (req, res) => {
        const send = (code: number, body: unknown): void => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { error: 'POST only' });

        let body = '';
        for await (const chunk of req) body += chunk;
        let address: Address, chainId: number;
        try {
          const j = JSON.parse(body || '{}');
          address = j.address;
          chainId = Number(j.chainId);
        } catch {
          return send(400, { error: 'bad json' });
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) return send(400, { error: 'bad address' });

        const cfg = CHAINS[chainId];
        if (!cfg) return send(400, { error: `no funding configured for chain ${chainId}` });

        const tag = `${chainId}:${address.toLowerCase()}`;
        if (funded.has(tag)) return send(200, { alreadyFunded: true });

        try {
          const account = privateKeyToAccount(key());
          const chain = {
            id: cfg.chainId, name: `chain-${cfg.chainId}`,
            nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 },
            rpcUrls: { default: { http: [cfg.rpcUrl] } },
          } as const;
          const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
          const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

          // Tempo rejects a transaction above 30M gas and its estimates run an
          // order of magnitude low, so transfers carry an explicit limit.
          const gasLimit = cfg.chainId === 42431 ? 29_000_000n : undefined;

          const hashes: string[] = [];
          if (cfg.gas.kind === 'native') {
            hashes.push(await wallet.sendTransaction({ to: address, value: cfg.gas.amount }));
          } else {
            hashes.push(await wallet.writeContract({
              address: cfg.gas.token, abi: ERC20, functionName: 'transfer',
              args: [address, cfg.gas.amount], gas: gasLimit,
            }));
          }
          // Mint rather than transfer: the demo tokens are owner-mintable, so
          // the faucet balance is not drawn down by every new signup.
          hashes.push(await wallet.writeContract({
            address: cfg.quoteToken, abi: ERC20, functionName: 'mint',
            args: [address, cfg.quoteAmount], gas: gasLimit,
          }));
          // Enough to create an auction at the form's default supply, with
          // room to create more than one.
          hashes.push(await wallet.writeContract({
            address: cfg.saleToken, abi: ERC20, functionName: 'mint',
            args: [address, cfg.saleAmount], gas: gasLimit,
          }));

          funded.add(tag);
          await pub.waitForTransactionReceipt({ hash: hashes[hashes.length - 1] as `0x${string}` });
          return send(200, { funded: true, hashes });
        } catch (e) {
          const m = (e as { shortMessage?: string; message?: string }).shortMessage
            ?? (e as Error).message ?? String(e);
          return send(500, { error: m.split('\n')[0] });
        }
      });
    },
  };
}

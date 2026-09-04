/**
 * Paying for an API call from the browser, with no wallet and no signup.
 *
 * The flow is the HTTP 402 handshake, end to end:
 *
 *   1. call the metered endpoint with no payment      -> 402 + requirements
 *   2. mint a keypair in this tab, fund it keylessly  -> tempo_fundAddress
 *   3. send the ERC-20 transfer the 402 asked for     -> a real transaction
 *   4. call again with X-PAYMENT: base64({txHash})    -> 200 and a receipt
 *
 * The key never leaves this tab and is never written to storage: it is minted
 * in memory, spends testnet PathUSD that the chain hands out for free, and is
 * gone when the tab closes. Nothing here asks the reader for an account, a
 * seed phrase or a card, which is the point of the demonstration rather than a
 * shortcut around it.
 *
 * Gas on Tempo is itself an ERC-20 (PathUSD, six decimals), so a payment and
 * its own gas come out of the same balance and `eth_getBalance` is not the
 * thing to read. That is why funding is confirmed with balanceOf.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: Address;
  payTo: Address;
  resource: string;
  description: string;
  extra: {
    symbol: string;
    decimals: number;
    chainId: number;
    rpc: string;
    explorer: string;
    priceDisplay: string;
  };
}

export interface Receipt {
  transaction: Hex;
  payer: Address;
  amount: string;
  explorer: string;
  network: string;
}

export interface PaidResult {
  response: Response;
  receipt: Receipt | null;
  /** Milliseconds spent paying, separate from the call itself, so the page can
   *  be honest about which part of the wait was the chain. */
  payMs: number;
}

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

/** How long to wait for keyless funding to actually show up. The RPC returns
 *  before the balance does, and a transfer fired in that gap reverts. */
const FUND_TIMEOUT_MS = 60_000;

export type Phase =
  | 'asking'
  | 'creating-wallet'
  | 'funding'
  | 'paying'
  | 'confirming'
  | 'retrying';

export interface PayerEvents {
  onPhase?: (phase: Phase, detail?: string) => void;
}

/**
 * One ephemeral payer per page. Kept across calls so the second paid call does
 * not mint and fund a second wallet for no reason.
 */
export class Payer {
  private key: Hex | null = null;
  private account: ReturnType<typeof privateKeyToAccount> | null = null;
  private funded = false;

  constructor(private readonly ev: PayerEvents = {}) {}

  get address(): Address | null {
    return this.account?.address ?? null;
  }

  /** Public so the fetch helper can report its own two phases through the same
   *  channel, rather than the caller having to wire up two listeners. */
  emit(p: Phase, detail?: string): void {
    this.ev.onPhase?.(p, detail);
  }

  private phase(p: Phase, detail?: string): void {
    this.emit(p, detail);
  }

  private clients(req: PaymentRequirements) {
    const chain = defineChain({
      id: req.extra.chainId,
      name: req.network,
      nativeCurrency: { name: req.extra.symbol, symbol: req.extra.symbol, decimals: 18 },
      rpcUrls: { default: { http: [req.extra.rpc] } },
    });
    const transport = http(req.extra.rpc);
    return {
      pub: createPublicClient({ chain, transport }),
      chain,
      transport,
    };
  }

  /** Balance in the asset a call is priced in, or null before there is a wallet. */
  async balance(req: PaymentRequirements): Promise<string | null> {
    if (!this.account) return null;
    const { pub } = this.clients(req);
    const bal = await pub.readContract({
      address: req.asset,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [this.account.address],
    });
    return formatUnits(bal, req.extra.decimals);
  }

  private async ensureWallet(req: PaymentRequirements): Promise<void> {
    if (!this.account) {
      this.phase('creating-wallet');
      this.key = generatePrivateKey();
      this.account = privateKeyToAccount(this.key);
    }
    if (this.funded) return;

    const { pub } = this.clients(req);
    const readBalance = async (): Promise<bigint> =>
      pub.readContract({
        address: req.asset,
        abi: ERC20,
        functionName: 'balanceOf',
        args: [this.account!.address],
      });

    // Already funded from an earlier call in this tab.
    if ((await readBalance()) > 0n) {
      this.funded = true;
      return;
    }

    this.phase('funding', this.account.address);
    await fetch(req.extra.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tempo_fundAddress',
        params: [this.account.address],
      }),
    });

    const until = Date.now() + FUND_TIMEOUT_MS;
    for (;;) {
      if ((await readBalance()) > 0n) {
        this.funded = true;
        return;
      }
      if (Date.now() > until) {
        throw new Error(
          'the testnet faucet did not fund this tab in time. Try again in a moment.',
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Send the transfer the 402 asked for, and wait until it is mined. */
  async pay(req: PaymentRequirements): Promise<Hex> {
    await this.ensureWallet(req);
    const { pub, chain, transport } = this.clients(req);
    const wallet = createWalletClient({ account: this.account!, chain, transport });

    this.phase('paying', req.extra.priceDisplay);
    const hash = await wallet.writeContract({
      address: req.asset,
      abi: ERC20,
      functionName: 'transfer',
      args: [req.payTo, BigInt(req.maxAmountRequired)],
    });

    this.phase('confirming', hash);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (rc.status !== 'success') {
      throw new Error('the payment transaction reverted, so nothing was charged.');
    }
    return hash;
  }
}

function decodeReceipt(res: Response): Receipt | null {
  const raw = res.headers.get('x-payment-response');
  if (!raw) return null;
  try {
    return JSON.parse(atob(raw)) as Receipt;
  } catch {
    return null;
  }
}

/**
 * Fetch through the 402 handshake.
 *
 * A 402 on the first call is the expected path, not an error: the server is
 * quoting a price. Anything else comes straight back, so a metered endpoint
 * that happens to be free today, or a real failure, is not mistaken for a
 * quote and paid for.
 */
export async function payAndFetch(
  url: string,
  init: RequestInit,
  payer: Payer,
): Promise<PaidResult> {
  payer.emit('asking');
  const first = await fetch(url, init);
  if (first.status !== 402) {
    return { response: first, receipt: decodeReceipt(first), payMs: 0 };
  }

  const quote = (await first.json()) as { accepts?: PaymentRequirements[] };
  const req = quote.accepts?.[0];
  if (!req) throw new Error('that endpoint asked for payment but did not say how much.');
  if (req.scheme !== 'tempo-transfer') {
    throw new Error(`this page can only pay the tempo-transfer scheme, not ${req.scheme}.`);
  }

  const started = performance.now();
  const hash = await payer.pay(req);
  const payMs = Math.round(performance.now() - started);

  payer.emit('retrying');
  const headers = new Headers(init.headers);
  headers.set('x-payment', btoa(JSON.stringify({ txHash: hash })));
  const second = await fetch(url, { ...init, headers });

  return { response: second, receipt: decodeReceipt(second), payMs };
}

/** The paid twin of a path: `/v1/rounds` is metered at `/v1/x402/rounds`. */
export function meteredPath(path: string): string {
  return path.startsWith('/v1/') ? `/v1/x402/${path.slice(4)}` : path;
}

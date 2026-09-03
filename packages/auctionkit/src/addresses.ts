/** Deployed AuctionKit contracts, per chain.
 *
 * Kept in source rather than an env var because these are public facts about a
 * public chain, and a wrong address here should be a failing test in CI rather
 * than a runtime surprise in somebody's browser.
 */
import { defineChain, type Address, type Hex } from 'viem';

export interface Deployment {
  chainId: number;
  name: string;
  committeeRegistry: Address;
  /** False when the deployed bytecode predates a fix that is already in this
   * repository. Clients must refuse to build bids against a stale template
   * rather than let a user commit funds to a contract we know is broken. */
  current: boolean;
  /** Why it is stale, if it is. */
  staleReason?: string;
  /** The clone template. Never an auction itself: its initializers are
   * permanently disabled, so it can hold no funds. */
  auctionImplementation: Address;
  /** Creates auctions, and is the registry of them. */
  factory: Address;
  factoryBlock: bigint;
  explorer: string;
  rpcUrl: string;
  /** What gas is paid in. Tempo has no native token and charges in a
   * stablecoin, so a UI that says "you need ETH" would be wrong there. */
  gasSymbol: string;
  /** Demo tokens and the faucet that hands out the quote side. */
  tokens: {
    saleToken: Address;
    saleSymbol: string;
    quoteToken: Address;
    quoteSymbol: string;
    /** Hands out the payment token. */
    faucet: Address;
    /** Hands out the sale token, so someone can create an auction and not
     * only bid in one. */
    saleFaucet?: Address;
  };
  /** An RPC method that funds gas, where the chain provides one.
   *
   * Tempo charges gas in PathUSD, so a new wallet holds nothing and cannot
   * send even a faucet claim. `tempo_fundAddress` breaks that circle from the
   * browser with no key and no backend, which is what makes the whole flow
   * self-serve rather than needing a funding service. */
  gasFaucetRpcMethod?: string;
  /** Where gas balance is read, on a chain that charges it as an ERC-20.
   * `eth_getBalance` is meaningless on Tempo, so the token is the only
   * truthful source. */
  gasToken?: Address;
  committeeSetId: Hex;
}

/** Tempo Moderato.
 *
 * Chosen over adding a Vara.eth layer for speed. Tempo settles with ~0.5s
 * deterministic BFT finality, which is strictly better than a preconfirmation:
 * a preconf is a soft promise that has to be caveated in the interface, and
 * this is settled. It also has EIP-2537, so onchain share verification stays
 * reachable here (see docs/auctionkit/decisions/0003).
 *
 * Gas is paid in PathUSD, not a native token. `eth_getBalance` is hardcoded and
 * `BALANCE`/`SELFBALANCE` return zero, so nothing here may depend on native
 * value. AuctionKit is entirely ERC-20, so it does not.
 */
export const TEMPO: Deployment = {
  chainId: 42431,
  name: 'Tempo Moderato',
  committeeRegistry: '0xA9228c1ceA27C86f700782e46Bb237e965f23b47',
  auctionImplementation: '0x5b7538dC18DBaE3b75C2FaE2Cd3BB5a705002AEB',
  factory: '0x165De57129F3EC3c13e72b496D22989dd7eC55EB',
  factoryBlock: 32750314n,
  explorer: 'https://explore.testnet.tempo.xyz',
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  gasSymbol: 'PathUSD',
  tokens: {
    saleToken: '0xdB1c20cF990Cd94c4806Aed7974Da8d4103A09b9',
    saleSymbol: 'PEALD',
    quoteToken: '0x94521876dbE846a1a3eccF6636c2ec8E0BE82091',
    quoteSymbol: 'DUSD',
    faucet: '0x7f49125581a3228379b01B73e19c4c9A831FE552',
    saleFaucet: '0x64F933e0e9cfE45720CD2c0F87c7EAfB88b16513',
  },
  gasFaucetRpcMethod: 'tempo_fundAddress',
  gasToken: '0x20c0000000000000000000000000000000000000',
  committeeSetId: '0xd19f4dd9a205e3edb80e46666fa6a6a02497bb16411755e9355413e4dea9327f',
  current: true,
};

/** Superseded. Kept so anyone holding one of these addresses learns why it
 * stopped working, instead of debugging a contract we already replaced. */
export const SUPERSEDED: Record<Address, string> = {
  '0x720063ab08722b86D2B1140D04F24523bD482B7A':
    'AuctionFactory pointing at an implementation with a fixed one hour dispute ' +
    'window. The window is now chosen per auction, so its clones cannot express ' +
    'a shorter one. Replaced by 0x165De57129F3EC3c13e72b496D22989dd7eC55EB',
  '0x05CB737305f2D4226011b3B50dD43D7a2e2de32b':
    'AuctionKit implementation deployed before fund() dropped its onlyIssuer guard. ' +
    'A factory cannot fund an auction it creates against this one, so createAuction ' +
    'reverts NotIssuer. Replaced by 0x5CA49EC0e0dF31beD979290239769862cd99524B',
  '0x3Ce04CA7a6de3D0603202d8693DB7EC4543B794E':
    'AuctionFactory pointing at that stale implementation. Replaced by 0x8bc14a5F8910E827AaFf61722522EeC795F32CeF',
  '0x3C918e75eb7037e50D5A319fDAa907CCe6048785':
    'AuctionKit implementation deployed before decisions/0004. bidCommitment bound bidId, ' +
    'and one mismatched reveal permanently prevented settlement. Replaced by ' +
    '0x5CA49EC0e0dF31beD979290239769862cd99524B',
};

/** One chain. Tempo settles in about half a second and charges gas in a
 * stablecoin a browser can claim with no key, which is what lets a creator make
 * an auction without signing in and a bidder enter one holding nothing. A
 * second chain would mean a chain picker on every page and a wallet that can be
 * on the wrong one, for no capability this product uses. */
export const DEPLOYMENTS: Record<number, Deployment> = {
  [TEMPO.chainId]: TEMPO,
};

/** Throws on a stale deployment. Callers that genuinely want the address
 * anyway — a redeploy script, an explorer link — should read `DEPLOYMENTS`
 * directly and check `current` themselves. */
export function deploymentFor(chainId: number): Deployment {
  const d = DEPLOYMENTS[chainId];
  if (d && !d.current) {
    throw new Error(`AuctionKit on ${d.name} is out of date and must not be used: ${d.staleReason}`);
  }
  if (!d) {
    const known = Object.values(DEPLOYMENTS)
      .map((x) => `${x.name} (${x.chainId})`)
      .join(', ');
    throw new Error(`AuctionKit is not deployed on chain ${chainId}. Known: ${known}`);
  }
  return d;
}

/** Canonical Multicall3, deployed at the same address on most EVM chains.
 * Verified present on Tempo before being declared here. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * The chain definition every client should use.
 *
 * Declaring `contracts.multicall3` is not decoration. viem's
 * `batch: { multicall: true }` needs an address to aggregate through, and
 * without one it silently does nothing: the option is accepted, no error is
 * raised, and every read still costs its own round trip. Measured against a
 * bare chain object, sixty reads took the same wall time batched as unbatched,
 * which is how the omission was found.
 *
 * This matters at scale rather than in the demo. A 200-bid auction is 200
 * `getBid` reads. Through multicall they aggregate into a handful of calls; one
 * by one they are 200, and the page crawls.
 */
function chainFor(d: Deployment) {
  return defineChain({
    id: d.chainId,
    name: d.name,
    nativeCurrency: { name: d.gasSymbol, symbol: d.gasSymbol, decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
    blockExplorers: { default: { name: 'Explorer', url: d.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: true,
  });
}

/** Chain definitions, keyed by id. */
export const CHAIN_FOR: Record<number, ReturnType<typeof chainFor>> = {
  [TEMPO.chainId]: chainFor(TEMPO),
};

export const tempoChain = CHAIN_FOR[TEMPO.chainId]!;

/**
 * The chain the app runs on.
 *
 * Tempo, for its ~0.5s deterministic BFT finality: a bid confirms about as fast
 * as the click, which is what the preconfirmation conversation was actually
 * after. It is also the only chain this app knows: gas is claimable from the
 * browser with no key, which is what lets a creator make an auction and a
 * bidder enter one without signing in.
 *
 * One export rather than a constant repeated across pages, because the failure
 * mode of getting it wrong in one place is a transaction sent to a chain the
 * wallet is not on, which is exactly the error this replaced.
 */
export const ACTIVE: Deployment = TEMPO;

/** The chain object for whatever ACTIVE is. */
export const activeChain = CHAIN_FOR[ACTIVE.chainId]!;

/** The demo auction on the active chain, if one has been created.
 *
 * Null when none exists yet, which the interface must handle rather than
 * rendering a page for an address that is not an auction. */
export const ACTIVE_DEMO: { auction: Address } | null = {
  auction: '0xCA90E426b2dF09C800CDb39b9F0BE00492E551B9',
};

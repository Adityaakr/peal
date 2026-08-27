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
    faucet: Address;
  };
  committeeSetId: Hex;
}

export const HOODI: Deployment = {
  chainId: 560048,
  name: 'Ethereum Hoodi',
  committeeRegistry: '0xDDDbE56276cCfA46144934D89A6c0cf06f208Ac7',
  auctionImplementation: '0x5CA49EC0e0dF31beD979290239769862cd99524B',
  factory: '0x8bc14a5F8910E827AaFf61722522EeC795F32CeF',
  /** The block the factory was deployed in. Reading AuctionCreated from here
   * rather than from zero is the difference between a listing that loads and
   * one no public RPC will finish. */
  factoryBlock: 3502790n,
  explorer: 'https://hoodi.etherscan.io',
  rpcUrl: 'https://rpc.hoodi.ethpandaops.io',
  gasSymbol: 'ETH',
  tokens: {
    saleToken: '0x25526E55ABcED385BE642Fb7A00506D6Fa28dcbF',
    saleSymbol: 'PEALD',
    quoteToken: '0xc246151117190833d671004bFB16c91b69b10356',
    quoteSymbol: 'DUSD',
    faucet: '0xbB80D8c0546E99Db85cEbf7DC99C521ceC41fB07',
  },
  committeeSetId: '0x919713e6844c14557b3da10b2deea33d9c00d70229bedadbb93d81f596d4af85',
  current: true,
};

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
  auctionImplementation: '0xfE4315435fC84c30b84D9316a3EE37b48FFBc40E',
  factory: '0x720063ab08722b86D2B1140D04F24523bD482B7A',
  factoryBlock: 32735509n,
  explorer: 'https://explore.testnet.tempo.xyz',
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  gasSymbol: 'PathUSD',
  tokens: {
    saleToken: '0xdB1c20cF990Cd94c4806Aed7974Da8d4103A09b9',
    saleSymbol: 'PEALD',
    quoteToken: '0x94521876dbE846a1a3eccF6636c2ec8E0BE82091',
    quoteSymbol: 'DUSD',
    faucet: '0x7f49125581a3228379b01B73e19c4c9A831FE552',
  },
  committeeSetId: '0xd19f4dd9a205e3edb80e46666fa6a6a02497bb16411755e9355413e4dea9327f',
  current: true,
};

/** Superseded. Kept so anyone holding one of these addresses learns why it
 * stopped working, instead of debugging a contract we already replaced. */
export const SUPERSEDED: Record<Address, string> = {
  '0x05CB737305f2D4226011b3B50dD43D7a2e2de32b':
    'AuctionKit implementation deployed before fund() dropped its onlyIssuer guard. ' +
    'A factory cannot fund an auction it creates against this one, so createAuction ' +
    'reverts NotIssuer. Replaced by ' + HOODI.auctionImplementation,
  '0x3Ce04CA7a6de3D0603202d8693DB7EC4543B794E':
    'AuctionFactory pointing at that stale implementation. Replaced by ' + HOODI.factory,
  '0x3C918e75eb7037e50D5A319fDAa907CCe6048785':
    'AuctionKit implementation deployed before decisions/0004. bidCommitment bound bidId, ' +
    'and one mismatched reveal permanently prevented settlement. Replaced by ' +
    HOODI.auctionImplementation,
};

/** A demo auction, open for bidding on Hoodi.
 *
 * The committee behind it is a prop with publicly derivable keys - see
 * DeployDemoAuction.s.sol. Testnet only, and nobody should be misled about
 * custody. */
export interface DemoAuction {
  chainId: number;
  auction: Address;
  saleToken: Address;
  saleSymbol: string;
  quoteToken: Address;
  quoteSymbol: string;
  /** The registered committee set new auctions snapshot. On this testnet its
   * signing keys are derived from a published string, so it is a prop rather
   * than custody. See DeployDemoAuction.s.sol. */
  committeeSetId: Hex;
  /** Hands out the quote token so anyone can try the auction. No owner, no
   * admin: it holds a balance and dispenses it under a per-call cap and a
   * per-address cooldown. */
  faucet: Address;
}

export const HOODI_DEMO: DemoAuction = {
  chainId: 560048,
  auction: '0x94521876dbE846a1a3eccF6636c2ec8E0BE82091',
  saleToken: '0xA9228c1ceA27C86f700782e46Bb237e965f23b47',
  saleSymbol: 'PEALD',
  quoteToken: '0xfE4315435fC84c30b84D9316a3EE37b48FFBc40E',
  quoteSymbol: 'DUSD',
  committeeSetId: '0x919713e6844c14557b3da10b2deea33d9c00d70229bedadbb93d81f596d4af85',
  faucet: '0xa727B494D1Aae7Ec34C4891D0dcf1426f8eD6C93',
};

export const DEPLOYMENTS: Record<number, Deployment> = {
  [HOODI.chainId]: HOODI,
  [TEMPO.chainId]: TEMPO,
};

/** Chains a user can pick between, in the order they should be offered. */
export const CHAINS: Deployment[] = [HOODI, TEMPO];

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
 * Verified present on Hoodi (7,619 bytes of code) before being declared here. */
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

/** Chain definitions, keyed by id. Multicall3 is verified present on both. */
export const CHAIN_FOR: Record<number, ReturnType<typeof chainFor>> = {
  [HOODI.chainId]: chainFor(HOODI),
  [TEMPO.chainId]: chainFor(TEMPO),
};

export const tempoChain = CHAIN_FOR[TEMPO.chainId]!;

export const hoodiChain = defineChain({
  id: HOODI.chainId,
  name: HOODI.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hoodi.ethpandaops.io'] } },
  blockExplorers: { default: { name: 'Etherscan', url: HOODI.explorer } },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

/** Permit-capable demo tokens, the defaults for new auctions.
 *
 * The original DUSD is a hand-rolled token with no EIP-2612, so a bid against
 * it will always cost two transactions and two wallet prompts. These are the
 * same demo money with permit, which makes bidding one signature and one
 * transaction. The old tokens still work; auctions quoted in them simply take
 * the approve path.
 */
export const HOODI_PERMIT_TOKENS = {
  saleToken: '0x25526E55ABcED385BE642Fb7A00506D6Fa28dcbF' as Address,
  saleSymbol: 'PEALD',
  quoteToken: '0xc246151117190833d671004bFB16c91b69b10356' as Address,
  quoteSymbol: 'DUSD',
  faucet: '0xbB80D8c0546E99Db85cEbf7DC99C521ceC41fB07' as Address,
} as const;

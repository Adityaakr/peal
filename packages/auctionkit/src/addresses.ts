/** Deployed AuctionKit contracts, per chain.
 *
 * Kept in source rather than an env var because these are public facts about a
 * public chain, and a wrong address here should be a failing test in CI rather
 * than a runtime surprise in somebody's browser.
 */
import type { Address } from 'viem';

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
  explorer: string;
}

export const HOODI: Deployment = {
  chainId: 560048,
  name: 'Ethereum Hoodi',
  committeeRegistry: '0xDDDbE56276cCfA46144934D89A6c0cf06f208Ac7',
  auctionImplementation: '0x05CB737305f2D4226011b3B50dD43D7a2e2de32b',
  explorer: 'https://hoodi.etherscan.io',
  current: true,
};

/** Superseded. Kept so anyone holding one of these addresses learns why it
 * stopped working, instead of debugging a contract we already replaced. */
export const SUPERSEDED: Record<Address, string> = {
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
  faucet: '0xa727B494D1Aae7Ec34C4891D0dcf1426f8eD6C93',
};

export const DEPLOYMENTS: Record<number, Deployment> = { [HOODI.chainId]: HOODI };

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

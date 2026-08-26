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
  committeeRegistry: '0x7C4338980D7a859368a9D1cb72764F480cc763C8',
  auctionImplementation: '0x3C918e75eb7037e50D5A319fDAa907CCe6048785',
  explorer: 'https://hoodi.etherscan.io',
  current: false,
  staleReason:
    'Deployed before the fix in decisions/0004: bidCommitment still binds bidId, ' +
    'and a single mismatched reveal permanently prevents the auction from settling. ' +
    'Redeploy the implementation before creating any auction.',
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

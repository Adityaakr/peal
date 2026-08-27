/** Reading and bidding on a `SealedBidAuction`.
 *
 * The bid path is the part worth reading carefully. A sealed bid means the
 * chain never sees the quantity or the price until the auction closes, so what
 * goes on-chain is a commitment and an escrow — and the escrow is the one thing
 * that *does* leak, because it is a token transfer. See `prepareBid`.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { SealedBidAuctionAbi, DemoTokenAbi } from './abi.js';
import { bidCommitment, randomSalt } from './commitment.js';
import { escrowFor, priceAt } from './clearing.js';
import { signPermit, supportsPermit } from './permit.js';

/** Mirrors the contract's `State` enum. Order is load-bearing. */
export enum AuctionState {
  Created = 0,
  Funded = 1,
  CommitOpen = 2,
  CommitClosed = 3,
  RevealPending = 4,
  Revealing = 5,
  ReadyToSettle = 6,
  Settled = 7,
  Failed = 8,
  Cancelled = 9,
}

export const STATE_LABELS: Record<AuctionState, string> = {
  [AuctionState.Created]: 'Created',
  [AuctionState.Funded]: 'Funded',
  [AuctionState.CommitOpen]: 'Bidding open',
  [AuctionState.CommitClosed]: 'Bidding closed',
  [AuctionState.RevealPending]: 'Awaiting reveal',
  [AuctionState.Revealing]: 'Revealing',
  [AuctionState.ReadyToSettle]: 'Ready to settle',
  [AuctionState.Settled]: 'Settled',
  [AuctionState.Failed]: 'Failed — refunds available',
  [AuctionState.Cancelled]: 'Cancelled — refunds available',
};

export interface AuctionConfig {
  issuer: Address;
  saleToken: Address;
  quoteToken: Address;
  totalSupply: bigint;
  saleDecimals: number;
  quoteDecimals: number;
  reservePrice: bigint;
  tickSize: bigint;
  numTicks: number;
  startTime: bigint;
  endTime: bigint;
  revealDeadline: bigint;
  minBidQuantity: bigint;
  maxQuantityPerAddress: bigint;
  maxBids: number;
  allowlistRoot: Hex;
  protocolFeeBps: number;
  feeRecipient: Address;
  committeeSetId: Hex;
  encryptionEpoch: Hex;
  metadataHash: Hex;
  version: number;
}

export interface AuctionSnapshot {
  address: Address;
  config: AuctionConfig;
  state: AuctionState;
  committedBidCount: number;
  processedBidCount: number;
  voidedBidCount: number;
  clearingPrice: bigint;
  /** True while a bid can still be placed, by the contract's own rules. */
  biddingOpen: boolean;
}

/**
 * @param nowSeconds  Override the reference time. Defaults to the chain's
 *   latest block timestamp, NOT the local clock: every deadline in the contract
 *   is compared against `block.timestamp`, so using wall-clock time here would
 *   make the client disagree with the chain about whether bidding is open
 *   whenever the two drift — which is always, on a test chain, and
 *   intermittently on a real one with a skewed local clock.
 */
export async function readAuction(
  client: PublicClient,
  address: Address,
  nowSeconds?: bigint,
): Promise<AuctionSnapshot> {
  const contract = { address, abi: SealedBidAuctionAbi } as const;
  const [config, state, committed, processed, voided, clearingPrice, block] = await Promise.all([
    client.readContract({ ...contract, functionName: 'getConfig' }),
    client.readContract({ ...contract, functionName: 'state' }),
    client.readContract({ ...contract, functionName: 'committedBidCount' }),
    client.readContract({ ...contract, functionName: 'processedBidCount' }),
    client.readContract({ ...contract, functionName: 'voidedBidCount' }),
    client.readContract({ ...contract, functionName: 'clearingPrice' }),
    client.getBlock(),
  ]);

  const cfg = config as unknown as AuctionConfig;
  const now = nowSeconds ?? block.timestamp;
  const s = Number(state) as AuctionState;

  return {
    address,
    config: cfg,
    state: s,
    committedBidCount: Number(committed),
    processedBidCount: Number(processed),
    voidedBidCount: Number(voided),
    clearingPrice: clearingPrice as bigint,
    biddingOpen:
      s === AuctionState.CommitOpen &&
      now >= cfg.startTime &&
      now < cfg.endTime &&
      Number(committed) < cfg.maxBids,
  };
}

/** The ladder of prices a bidder chooses between. */
export function priceLadder(cfg: AuctionConfig): { tick: number; price: bigint }[] {
  return Array.from({ length: cfg.numTicks }, (_, tick) => ({
    tick,
    price: priceAt(cfg.reservePrice, cfg.tickSize, tick),
  }));
}

export interface PreparedBid {
  salt: Hex;
  commitment: Hex;
  escrow: bigint;
  quantity: bigint;
  maxPriceTick: number;
  bidVersion: number;
}

export class BidValidationError extends Error {}

/**
 * Build everything a bid needs, locally.
 *
 * ## Keep the salt
 *
 * Losing it means the bid can never be revealed: the commitment cannot be
 * reproduced, so the reveal is voided and the escrow is refunded with no
 * allocation. The salt is the only piece of a bid that exists nowhere but the
 * bidder's machine until the auction closes.
 *
 * ## What the escrow leaks
 *
 * The escrow is `quantity x price(maxPriceTick)`, moved as a visible ERC-20
 * transfer. Anyone watching the chain sees that product. They cannot separate
 * the two factors, but they can bound them, and a distinctive amount is
 * effectively a fingerprint.
 *
 * So this does NOT provide bid-size privacy, and nothing in AuctionKit claims
 * it does. What is hidden is the split between quantity and price, and — until
 * the close — the mapping from bid to outcome. Shielded funding would be needed
 * for the stronger claim, and it is not implemented.
 */
export function prepareBid(args: {
  cfg: AuctionConfig;
  chainId: number;
  auction: Address;
  bidder: Address;
  quantity: bigint;
  maxPriceTick: number;
  salt?: Hex;
  bidVersion?: number;
}): PreparedBid {
  const { cfg, quantity, maxPriceTick } = args;

  // Checked here rather than left to revert on-chain: a bidder should learn
  // their bid is ineligible before paying gas, not at reveal when it is voided.
  if (maxPriceTick < 0 || maxPriceTick >= cfg.numTicks) {
    throw new BidValidationError(`maxPriceTick must be within 0..${cfg.numTicks - 1}`);
  }
  if (quantity < cfg.minBidQuantity) {
    throw new BidValidationError(`quantity is below the auction minimum of ${cfg.minBidQuantity}`);
  }
  if (cfg.maxQuantityPerAddress !== 0n && quantity > cfg.maxQuantityPerAddress) {
    throw new BidValidationError(`quantity exceeds the per-address cap of ${cfg.maxQuantityPerAddress}`);
  }

  const salt = args.salt ?? randomSalt();
  const bidVersion = args.bidVersion ?? 1;
  const escrow = escrowFor(quantity, cfg.reservePrice, cfg.tickSize, maxPriceTick, cfg.saleDecimals);

  return {
    salt,
    bidVersion,
    quantity,
    maxPriceTick,
    escrow,
    commitment: bidCommitment({
      chainId: args.chainId,
      auction: args.auction,
      bidder: args.bidder,
      quantity,
      maxPriceTick,
      salt,
      bidVersion,
    }),
  };
}

/** Approve the escrow, then commit the bid. Two transactions; the approval is
 * skipped when the existing allowance already covers it. */
export async function submitBid(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account | Address;
  auction: Address;
  quoteToken: Address;
  bid: PreparedBid;
  ciphertextHash: Hex;
  allowlistProof?: Hex[];
}): Promise<{ approvalTx?: Hex; commitTx: Hex; bidId: number }> {
  const owner = typeof args.account === 'string' ? args.account : args.account.address;

  const allowance = (await args.publicClient.readContract({
    address: args.quoteToken,
    abi: DemoTokenAbi,
    functionName: 'allowance',
    args: [owner, args.auction],
  })) as bigint;

  // One transaction where the token allows it. A permit turns the approval
  // into a signature, so the bidder sees one wallet prompt instead of two and
  // waits one block instead of two. That is a larger cut in perceived time
  // than any change of chain, because the second prompt is where people stop.
  if (allowance < args.bid.escrow && (await supportsPermit(args.publicClient, args.quoteToken))) {
    const permit = await signPermit({
      publicClient: args.publicClient,
      walletClient: args.walletClient,
      account: args.account,
      token: args.quoteToken,
      spender: args.auction,
      value: args.bid.escrow,
    });

    const commitTx = await args.walletClient.writeContract({
      chain: null,
      account: args.account,
      address: args.auction,
      abi: SealedBidAuctionAbi,
      functionName: 'commitBidWithPermit',
      args: [
        args.bid.commitment,
        args.ciphertextHash,
        args.bid.escrow,
        args.allowlistProof ?? [],
        permit.deadline,
        permit.v,
        permit.r,
        permit.s,
      ],
    });
    return { commitTx, bidId: await bidIdFrom(args.publicClient, args.auction, commitTx) };
  }

  let approvalTx: Hex | undefined;
  if (allowance < args.bid.escrow) {
    approvalTx = await args.walletClient.writeContract({
      chain: null,
      account: args.account,
      address: args.quoteToken,
      abi: DemoTokenAbi,
      functionName: 'approve',
      args: [args.auction, args.bid.escrow],
    });
    await args.publicClient.waitForTransactionReceipt({ hash: approvalTx });
  }

  // Read the id AFTER the commit lands, never before: it is assigned inside
  // commitBid. Nothing depends on predicting it — the commitment does not bind
  // it — but the bidder still needs to know which id is theirs in order to
  // claim.
  const commitTx = await args.walletClient.writeContract({
    chain: null,
    account: args.account,
    address: args.auction,
    abi: SealedBidAuctionAbi,
    functionName: 'commitBid',
    args: [args.bid.commitment, args.ciphertextHash, args.bid.escrow, args.allowlistProof ?? []],
  });
  return { approvalTx, commitTx, bidId: await bidIdFrom(args.publicClient, args.auction, commitTx) };
}

/** Which bid id the chain assigned.
 *
 * Read from the event after the fact rather than predicted. The contract
 * assigns it, nothing binds it into the commitment, and predicting it was the
 * race that let one bidder commit to another's id. */
async function bidIdFrom(client: PublicClient, auction: Address, commitTx: Hex): Promise<number> {
  const receipt = await client.waitForTransactionReceipt({ hash: commitTx });
  if (receipt.status !== 'success') throw new Error('commitBid reverted');

  const logs = await client.getContractEvents({
    address: auction,
    abi: SealedBidAuctionAbi,
    eventName: 'BidCommitted',
    blockHash: receipt.blockHash,
  });
  const mine = logs.find((l) => l.transactionHash === commitTx);
  if (!mine) throw new Error('commitBid succeeded but emitted no BidCommitted event');
  return Number((mine.args as { bidId: number }).bidId);
}

export interface CommittedBid {
  bidId: number;
  bidder: Address;
  commitment: Hex;
  ciphertextHash: Hex;
  escrow: bigint;
  /** Block the bid was committed in, recorded by the contract itself. */
  blockNumber: bigint;
  /** Populated only once the auction has revealed. Before that these are not
   * "unknown to this client" - they are unknown to everyone, which is the
   * product. */
  revealed: boolean;
  voided: boolean;
  claimed: boolean;
  quantity: bigint;
  tick: number;
}

/**
 * Every bid committed to an auction.
 *
 * Reads contract storage, deliberately, rather than `BidCommitted` logs.
 *
 * The log version scanned from block 0, which on a chain a few million blocks
 * deep is a request no public RPC will finish - it timed out against Hoodi
 * every time. Passing a start block would have hidden the problem rather than
 * fixed it, because the caller would still have to know the deployment block
 * and would still be one redeploy away from silently missing bids.
 *
 * Storage has no such failure mode. `committedBidCount` is authoritative, ids
 * are dense from zero, and `getBid` already carries the commit block. The only
 * thing logs offered on top was the transaction hash, which nothing here needs:
 * a bidder's own transaction hash comes back from `submitBid` at the time they
 * send it.
 *
 * Calls are issued in bounded waves so a large auction cannot fire hundreds of
 * simultaneous requests at an RPC that will start refusing them.
 */
export async function readBids(
  client: PublicClient,
  auction: Address,
  opts: { concurrency?: number } = {},
): Promise<CommittedBid[]> {
  const count = Number(
    (await client.readContract({
      address: auction,
      abi: SealedBidAuctionAbi,
      functionName: 'committedBidCount',
    })) as number,
  );
  if (!count) return [];

  const concurrency = Math.max(1, opts.concurrency ?? 20);
  const out: CommittedBid[] = [];

  for (let start = 0; start < count; start += concurrency) {
    const ids = Array.from(
      { length: Math.min(concurrency, count - start) },
      (_, k) => start + k,
    );
    const wave = await Promise.all(
      ids.map(async (bidId) => {
        const b = (await client.readContract({
          address: auction,
          abi: SealedBidAuctionAbi,
          functionName: 'getBid',
          args: [bidId],
        })) as {
          bidder: Address; commitment: Hex; ciphertextHash: Hex; escrow: bigint;
          blockNumber: bigint; revealed: boolean; claimed: boolean; voided: boolean;
          quantity: bigint; tick: number;
        };
        return {
          bidId,
          bidder: b.bidder,
          commitment: b.commitment,
          ciphertextHash: b.ciphertextHash,
          escrow: b.escrow,
          blockNumber: b.blockNumber,
          revealed: b.revealed,
          voided: b.voided,
          claimed: b.claimed,
          quantity: b.quantity,
          tick: b.tick,
        } satisfies CommittedBid;
      }),
    );
    out.push(...wave);
  }

  return out;
}

/** Demand per tick, from revealed bids only.
 *
 * Returns null while any bid is still sealed: a partial demand curve invites
 * the reader to treat it as the real one, and before the close it is not just
 * incomplete but structurally unknowable. */
export function demandFromBids(bids: CommittedBid[], numTicks: number): bigint[] | null {
  if (!bids.length || bids.some((b) => !b.revealed && !b.voided)) return null;
  const demand = new Array<bigint>(numTicks).fill(0n);
  for (const b of bids) {
    if (b.revealed && !b.voided && b.tick < numTicks) demand[b.tick]! += b.quantity;
  }
  return demand;
}

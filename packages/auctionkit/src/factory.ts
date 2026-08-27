/** Creating auctions, and listing the ones that exist.
 *
 * The listing comes from `AuctionCreated` logs, not from a server. That is a
 * deliberate choice rather than a missing feature: an index held in one
 * database is exactly as available, and exactly as honest, as that database,
 * which is the wrong property for the one part of a trust-minimised product
 * that tells you what exists.
 *
 * Logs are read from the factory's deployment block. Reading from zero is what
 * made the first bid loader time out on a chain several million blocks deep,
 * and the fix is not a smaller range but a correct starting point.
 */
import {
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { AuctionFactoryAbi, DemoTokenAbi } from './abi.js';
import type { AuctionConfig } from './auction.js';

/** What kind of sale this is. Free text on the chain; a fixed list here so the
 * interface can group and filter without every issuer inventing a spelling. */
export const USE_CASES = [
  { id: 'token-launch', label: 'Token launch' },
  { id: 'dao-treasury', label: 'DAO treasury sale' },
  { id: 'nft-primary', label: 'NFT primary sale' },
  { id: 'rwa-issuance', label: 'RWA or treasury issuance' },
  { id: 'tournament', label: 'Tournament or prize pool' },
  { id: 'campaign', label: 'Campaign or fundraise' },
  { id: 'other', label: 'Something else' },
] as const;

export type UseCaseId = (typeof USE_CASES)[number]['id'];

export function useCaseLabel(id: string): string {
  return USE_CASES.find((u) => u.id === id)?.label ?? id;
}

export interface AuctionListing {
  auction: Address;
  issuer: Address;
  saleToken: Address;
  quoteToken: Address;
  totalSupply: bigint;
  startTime: bigint;
  endTime: bigint;
  name: string;
  useCase: string;
  details: string;
  blockNumber: bigint;
}

/** The hash the factory will check `cfg.metadataHash` against.
 *
 * Computed here so a client produces the same value the contract does rather
 * than guessing an encoding. A mismatch reverts at creation, which is the
 * right place: a label that does not match its auction should never exist. */
export function metadataHash(name: string, useCase: string, details: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'string' }], [name, useCase, details]),
  );
}

/** Every auction the factory has created, newest first. */
export async function readListings(
  client: PublicClient,
  factory: Address,
  fromBlock: bigint,
): Promise<AuctionListing[]> {
  const logs = await client.getContractEvents({
    address: factory,
    abi: AuctionFactoryAbi,
    eventName: 'AuctionCreated',
    fromBlock,
    toBlock: 'latest',
  });

  return logs
    .map((log) => {
      const a = log.args as Partial<AuctionListing>;
      return {
        auction: a.auction as Address,
        issuer: a.issuer as Address,
        saleToken: a.saleToken as Address,
        quoteToken: a.quoteToken as Address,
        totalSupply: a.totalSupply ?? 0n,
        startTime: a.startTime ?? 0n,
        endTime: a.endTime ?? 0n,
        name: a.name ?? '',
        useCase: a.useCase ?? '',
        details: a.details ?? '',
        blockNumber: log.blockNumber ?? 0n,
      };
    })
    .filter((l) => !!l.auction)
    .reverse();
}

export class CreateValidationError extends Error {}

export interface CreateArgs {
  cfg: AuctionConfig;
  name: string;
  useCase: string;
  details: string;
}

/**
 * Check what the contract will check, before spending gas on finding out.
 *
 * Every rule here mirrors a `require` in `SealedBidAuction.initialize` or
 * `AuctionFactory.createAuction`. It exists so an issuer sees a sentence rather
 * than a reverted transaction, not as a substitute for the contract, which
 * remains the authority.
 */
export function validateCreate(args: CreateArgs, nowSeconds: bigint): string[] {
  const { cfg } = args;
  const problems: string[] = [];

  if (!args.name.trim()) problems.push('Give the auction a name.');
  if (args.name.length > 80) problems.push('Name is too long, keep it under 80 characters.');
  if (cfg.totalSupply <= 0n) problems.push('Supply must be more than zero.');
  if (cfg.saleToken.toLowerCase() === cfg.quoteToken.toLowerCase()) {
    problems.push('The sale token and the payment token must be different.');
  }
  if (cfg.numTicks === 0 || cfg.numTicks > 256) problems.push('Price steps must be between 1 and 256.');
  if (cfg.startTime >= cfg.endTime) problems.push('Bidding must close after it opens.');
  if (cfg.endTime <= nowSeconds) problems.push('Bidding closes in the past.');
  // VOID_DISPUTE_WINDOW is 1 hour, and initialize requires the reveal window to
  // clear it. Without that a late void leaves no time to finalize, which is the
  // denial of service voiding exists to remove.
  if (cfg.revealDeadline < cfg.endTime + 3600n) {
    problems.push('Leave at least an hour between bidding closing and the reveal deadline.');
  }
  if (cfg.protocolFeeBps > 1000) problems.push('Fee cannot exceed 10 percent.');
  if (cfg.minBidQuantity <= 0n) problems.push('Minimum bid must be more than zero.');
  if (cfg.maxQuantityPerAddress !== 0n && cfg.maxQuantityPerAddress < cfg.minBidQuantity) {
    problems.push('The per-address cap is below the minimum bid, so no bid could ever qualify.');
  }
  return problems;
}

/**
 * Approve the supply, then create the auction.
 *
 * Two transactions, and the order matters: the factory pulls the full supply
 * during creation, so an auction is either absent or fully backed. There is no
 * intermediate state where one exists holding nothing.
 */
export async function createAuction(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account | Address;
  chain: WalletClient['chain'];
  factory: Address;
  create: CreateArgs;
}): Promise<{ approvalTx?: Hex; createTx: Hex; auction: Address }> {
  const owner = typeof args.account === 'string' ? args.account : args.account.address;
  const { cfg } = args.create;

  const allowance = (await args.publicClient.readContract({
    address: cfg.saleToken,
    abi: DemoTokenAbi,
    functionName: 'allowance',
    args: [owner, args.factory],
  })) as bigint;

  let approvalTx: Hex | undefined;
  if (allowance < cfg.totalSupply) {
    approvalTx = await args.walletClient.writeContract({
      chain: args.chain,
      account: args.account,
      address: cfg.saleToken,
      abi: DemoTokenAbi,
      functionName: 'approve',
      args: [args.factory, cfg.totalSupply],
    });
    await args.publicClient.waitForTransactionReceipt({ hash: approvalTx });
  }

  const createTx = await args.walletClient.writeContract({
    chain: args.chain,
    account: args.account,
    address: args.factory,
    abi: AuctionFactoryAbi,
    functionName: 'createAuction',
    args: [cfg, args.create.name, args.create.useCase, args.create.details],
  });
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash: createTx });
  if (receipt.status !== 'success') throw new Error('createAuction reverted');

  // The address comes from the event rather than being predicted, because a
  // clone's address depends on the factory's nonce and predicting it is a
  // second implementation that can silently disagree.
  const logs = await args.publicClient.getContractEvents({
    address: args.factory,
    abi: AuctionFactoryAbi,
    eventName: 'AuctionCreated',
    blockHash: receipt.blockHash,
  });
  const mine = logs.find((l) => l.transactionHash === createTx);
  if (!mine) throw new Error('createAuction succeeded but emitted no AuctionCreated event');

  return { approvalTx, createTx, auction: (mine.args as { auction: Address }).auction };
}

/** The whole auction, end to end, against a real EVM.
 *
 * Deploys the actual forge bytecode to a local anvil, places bids through the
 * real client (`prepareBid` / `submitBid`), has a threshold of committee keys
 * sign a reveal root, processes reveals, finalizes and claims.
 *
 * The Solidity tests already cover the contract in isolation. What this covers
 * is the seam between the client and the chain — specifically that the
 * commitment the TypeScript builds is the one the contract recomputes at
 * reveal. A mismatch there does not revert; it silently voids every bid, which
 * is exactly the kind of failure a unit test on either side alone would miss.
 *
 * Skips itself when anvil is not running, so it never fails CI spuriously:
 *   anvil --port 8545 --silent &
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEventLogs,
  publicActions,
  walletActions,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { SealedBidAuctionAbi, CommitteeRegistryAbi, DemoTokenAbi } from '../src/abi.js';
import { prepareBid, readAuction, submitBid, AuctionState } from '../src/auction.js';
import { revealLeaf } from '../src/commitment.js';
import { allocationFor, findClearingTick } from '../src/clearing.js';
import { bytecodeOf, minimalProxy } from './artifacts.js';

const RPC = 'http://localhost:8545';
/** anvil's documented default mnemonic. Not a credential. */
const MNEMONIC = 'test test test test test test test test test test test junk';

const ONE = 10n ** 18n;
const SUPPLY = 1000n * ONE;
const RESERVE = ONE;
const TICK_SIZE = ONE / 10n;
const NUM_TICKS = 32;

let up = false;
try {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  up = r.ok;
} catch {
  up = false;
}

const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const test = createTestClient({ chain: foundry, transport, mode: 'anvil' })
  .extend(publicActions)
  .extend(walletActions);

const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const carol = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });

/** Committee members sign off-chain only, so they never need gas. */
const committee: HDAccount[] = [4, 5, 6, 7, 8].map((i) =>
  mnemonicToAccount(MNEMONIC, { addressIndex: i }),
);

async function deploy(file: string, name: string, abi: readonly unknown[], args: unknown[]) {
  const hash = await test.deployContract({
    chain: foundry,
    account: deployer,
    abi: abi as never,
    bytecode: bytecodeOf(file, name),
    args: args as never,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`${name} deploy produced no address`);
  return r.contractAddress;
}

describe.skipIf(!up)('AuctionKit end to end on anvil', () => {
  let registry: Address;
  let auction: Address;
  let sale: Address;
  let quote: Address;
  let sortedCommittee: HDAccount[];
  let endTime: bigint;

  beforeAll(async () => {
    registry = await deploy('CommitteeRegistry.sol', 'CommitteeRegistry', CommitteeRegistryAbi, []);
    const impl = await deploy('SealedBidAuction.sol', 'SealedBidAuction', SealedBidAuctionAbi, []);
    sale = await deploy('DemoToken.sol', 'DemoToken', DemoTokenAbi, ['Sale', 'SALE', deployer.address]);
    quote = await deploy('DemoToken.sol', 'DemoToken', DemoTokenAbi, ['Quote', 'QUOTE', deployer.address]);

    // The contract requires signatures ordered by ascending signer, which is
    // how it enforces uniqueness in one pass.
    sortedCommittee = [...committee].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );

    const setTx = await test.writeContract({
      chain: foundry,
      account: deployer,
      address: registry,
      abi: CommitteeRegistryAbi,
      functionName: 'registerCommitteeSet',
      args: [3, sortedCommittee.map((c) => c.address)],
    });
    await pub.waitForTransactionReceipt({ hash: setTx });
    const setId = (await pub.readContract({
      address: registry,
      abi: CommitteeRegistryAbi,
      functionName: 'computeSetId',
      args: [3, sortedCommittee.map((c) => c.address)],
    })) as Hex;

    // Clone, because the implementation's initializers are disabled.
    const cloneHash = await test.sendTransaction({
      chain: foundry,
      account: deployer,
      data: minimalProxy(impl),
    });
    const cloneReceipt = await pub.waitForTransactionReceipt({ hash: cloneHash });
    auction = cloneReceipt.contractAddress!;

    const now = (await pub.getBlock()).timestamp;
    endTime = now + 1000n;

    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry,
        account: deployer,
        address: auction,
        abi: SealedBidAuctionAbi,
        functionName: 'initialize',
        args: [
          {
            issuer: deployer.address,
            saleToken: sale,
            quoteToken: quote,
            totalSupply: SUPPLY,
            saleDecimals: 18,
            quoteDecimals: 18,
            reservePrice: RESERVE,
            tickSize: TICK_SIZE,
            numTicks: NUM_TICKS,
            startTime: now,
            endTime,
            // Must clear VOID_DISPUTE_WINDOW.
            revealDeadline: endTime + 4n * 3600n,
            minBidQuantity: ONE,
            maxQuantityPerAddress: 0n,
            maxBids: 256,
            allowlistRoot: `0x${'0'.repeat(64)}`,
            protocolFeeBps: 100,
            feeRecipient: deployer.address,
            committeeSetId: setId,
            encryptionEpoch: keccak256('0x01'),
            metadataHash: keccak256('0x02'),
            version: 1,
          },
          registry,
        ],
      }),
    });

    // Fund the auction and open bidding.
    for (const [to, amount] of [[deployer.address, SUPPLY]] as const) {
      await pub.waitForTransactionReceipt({
        hash: await test.writeContract({
          chain: foundry, account: deployer, address: sale, abi: DemoTokenAbi,
          functionName: 'mint', args: [to, amount],
        }),
      });
    }
    for (const who of [alice, bob, carol]) {
      await pub.waitForTransactionReceipt({
        hash: await test.writeContract({
          chain: foundry, account: deployer, address: quote, abi: DemoTokenAbi,
          functionName: 'mint', args: [who.address, 100_000n * ONE],
        }),
      });
    }
    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: sale, abi: DemoTokenAbi,
        functionName: 'approve', args: [auction, SUPPLY],
      }),
    });
    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'fund', args: [],
      }),
    });
    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'openCommit', args: [],
      }),
    });
  }, 120_000);

  it('runs a full sealed-bid auction and settles at the uniform clearing price', async () => {
    const snap = await readAuction(pub, auction);
    expect(snap.state).toBe(AuctionState.CommitOpen);
    expect(snap.biddingOpen).toBe(true);

    // Oversubscribed: 500 + 700 + 1000 chasing 1000 supply.
    const specs = [
      { who: alice, quantity: 500n * ONE, tick: 20 },
      { who: bob, quantity: 700n * ONE, tick: 10 },
      { who: carol, quantity: 1000n * ONE, tick: 0 },
    ];

    const placed: { bidId: number; quantity: bigint; tick: number; salt: Hex }[] = [];
    for (const s of specs) {
      const bid = prepareBid({
        cfg: snap.config,
        chainId: foundry.id,
        auction,
        bidder: s.who.address,
        quantity: s.quantity,
        maxPriceTick: s.tick,
      });
      const wallet = createWalletClient({ account: s.who, chain: foundry, transport });
      const res = await submitBid({
        publicClient: pub,
        walletClient: wallet,
        account: s.who,
        auction,
        quoteToken: quote,
        bid,
        ciphertextHash: keccak256(encodeAbiParameters([{ type: 'string' }], [s.who.address])),
      });
      placed.push({ bidId: res.bidId, quantity: bid.quantity, tick: bid.maxPriceTick, salt: bid.salt });
    }

    expect(placed.map((p) => p.bidId)).toEqual([0, 1, 2]);

    // Close bidding.
    await test.setNextBlockTimestamp({ timestamp: endTime });
    await test.mine({ blocks: 1 });
    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'closeCommit', args: [],
      }),
    });

    // --- the committee's job -------------------------------------------
    // Leaves in bidId order, then an OZ-style sorted-pair merkle tree.
    const leaves = placed.map((p) => revealLeaf(p.bidId, p.quantity, p.tick, p.salt));
    const hashPair = (x: Hex, y: Hex) =>
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }],
          x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x],
        ),
      );
    const layer1 = [hashPair(leaves[0]!, leaves[1]!), leaves[2]!];
    const root = hashPair(layer1[0]!, layer1[1]!);
    const proofs: Hex[][] = [
      [leaves[1]!, layer1[1]!],
      [leaves[0]!, layer1[1]!],
      [layer1[0]!],
    ];

    const digest = (await pub.readContract({
      address: auction, abi: SealedBidAuctionAbi,
      functionName: 'revealRootDigest', args: [root, 3],
    })) as Hex;

    // A threshold of members signs; the contract requires ascending order.
    const signatures = await Promise.all(
      sortedCommittee.slice(0, 3).map((m) => m.sign({ hash: digest })),
    );

    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'registerRevealRoot', args: [root, 3, signatures],
      }),
    });

    const revealReceipt = await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'processReveals',
        args: [
          placed.map((p, i) => ({
            bidId: p.bidId,
            quantity: p.quantity,
            tick: p.tick,
            salt: p.salt,
            bidVersion: 1,
            proof: proofs[i]!,
          })),
        ],
      }),
    });

    // THE assertion this whole test exists for: not one bid was voided, which
    // means the TypeScript commitment matched what the contract recomputed.
    const voidedLogs = parseEventLogs({
      abi: SealedBidAuctionAbi, eventName: 'BidVoided', logs: revealReceipt.logs,
    });
    expect(voidedLogs, 'a voided bid means the TS commitment disagreed with the contract').toHaveLength(0);

    const afterReveal = await readAuction(pub, auction);
    expect(afterReveal.processedBidCount).toBe(3);
    expect(afterReveal.voidedBidCount).toBe(0);

    // Nothing was voided, so settlement needs no dispute window.
    await pub.waitForTransactionReceipt({
      hash: await test.writeContract({
        chain: foundry, account: deployer, address: auction, abi: SealedBidAuctionAbi,
        functionName: 'finalize', args: [],
      }),
    });

    const settled = await readAuction(pub, auction);
    expect(settled.state).toBe(AuctionState.Settled);

    // --- the client's prediction must match the chain -------------------
    const demand = new Array<bigint>(NUM_TICKS).fill(0n);
    for (const p of placed) demand[p.tick]! += p.quantity;
    const predicted = findClearingTick(demand, SUPPLY);

    expect(predicted.cleared).toBe(true);
    // 500 @ 20 + 700 @ 10 = 1200 >= 1000, so tick 10 clears.
    expect(predicted.clearingTick).toBe(10);
    expect(settled.clearingPrice).toBe(RESERVE + BigInt(predicted.clearingTick) * TICK_SIZE);

    for (const p of placed) {
      const onchain = (await pub.readContract({
        address: auction, abi: SealedBidAuctionAbi,
        functionName: 'allocationOf', args: [p.bidId],
      })) as bigint;
      expect(
        allocationFor(predicted, p.quantity, p.tick),
        `client prediction disagreed with the chain for bid ${p.bidId}`,
      ).toBe(onchain);
    }

    // Alice was above the clearing tick: filled in full, and pays the clearing
    // price rather than the 3.00 she was willing to pay.
    const aliceAlloc = allocationFor(predicted, 500n * ONE, 20);
    expect(aliceAlloc).toBe(500n * ONE);

    // Bob is at the clearing tick and gets the pro-rata remainder.
    expect(allocationFor(predicted, 700n * ONE, 10)).toBe(500n * ONE);
    // Carol bid below it and gets nothing.
    expect(allocationFor(predicted, 1000n * ONE, 0)).toBe(0n);

    // --- claims ---------------------------------------------------------
    const saleBefore = (await pub.readContract({
      address: sale, abi: DemoTokenAbi, functionName: 'balanceOf', args: [alice.address],
    })) as bigint;

    for (const [i, who] of [alice, bob, carol].entries()) {
      const w = createWalletClient({ account: who, chain: foundry, transport });
      await pub.waitForTransactionReceipt({
        hash: await w.writeContract({
          chain: foundry, address: auction, abi: SealedBidAuctionAbi,
          functionName: 'claim', args: [placed[i]!.bidId],
        }),
      });
    }

    const saleAfter = (await pub.readContract({
      address: sale, abi: DemoTokenAbi, functionName: 'balanceOf', args: [alice.address],
    })) as bigint;
    expect(saleAfter - saleBefore).toBe(aliceAlloc);

    // Carol bid below the clearing price, so she gets every quote token back.
    const carolQuote = (await pub.readContract({
      address: quote, abi: DemoTokenAbi, functionName: 'balanceOf', args: [carol.address],
    })) as bigint;
    expect(carolQuote).toBe(100_000n * ONE);
  }, 180_000);
});

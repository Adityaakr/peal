/** The permit path, against a real EVM.
 *
 * The unit tests prove the contract accepts a permit. This proves the *client*
 * builds one the contract accepts, which is a different claim: the domain, the
 * nonce and the v/r/s split are all places where a signature can be well formed
 * and still recover to the wrong address. A permit that silently fails does not
 * revert, it just leaves no allowance, so the failure surfaces as a confusing
 * transfer error rather than a signature error.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient, createTestClient, createWalletClient, http, keccak256,
  publicActions, stringToHex, walletActions, type Address,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { SealedBidAuctionAbi, CommitteeRegistryAbi, PermitTokenAbi } from '../src/abi.js';
import { prepareBid, readAuction, submitBid } from '../src/auction.js';
import { signPermit, supportsPermit } from '../src/permit.js';
import { bytecodeOf, minimalProxy } from './artifacts.js';

const RPC = 'http://localhost:8545';
const MNEMONIC = 'test test test test test test test test test test test junk';
const ONE = 10n ** 18n;

let up = false;
try {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
  up = r.ok;
} catch { up = false; }

const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const test = createTestClient({ chain: foundry, transport, mode: 'anvil' }).extend(publicActions).extend(walletActions);
const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const griefer = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

describe.skipIf(!up)('permit, end to end', () => {
  let auction: Address;
  let quote: Address;

  beforeAll(async () => {
    const deploy = async (file: string, name: string, abi: readonly unknown[], args: unknown[]) => {
      const hash = await test.deployContract({ chain: foundry, account: deployer,
        abi: abi as never, bytecode: bytecodeOf(file, name), args: args as never });
      const r = await pub.waitForTransactionReceipt({ hash });
      return r.contractAddress!;
    };

    const registry = await deploy('CommitteeRegistry.sol', 'CommitteeRegistry', CommitteeRegistryAbi, []);
    const impl = await deploy('SealedBidAuction.sol', 'SealedBidAuction', SealedBidAuctionAbi, []);
    const sale = await deploy('PermitToken.sol', 'PermitToken', PermitTokenAbi, ['Sale', 'SALE', deployer.address]);
    quote = await deploy('PermitToken.sol', 'PermitToken', PermitTokenAbi, ['Quote', 'QUOTE', deployer.address]);

    const members = [4, 5, 6, 7, 8].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }))
      .map((a) => a.address).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
      address: registry, abi: CommitteeRegistryAbi, functionName: 'registerCommitteeSet', args: [3, members] }) });
    const setId = await pub.readContract({ address: registry, abi: CommitteeRegistryAbi,
      functionName: 'computeSetId', args: [3, members] });

    const cloneHash = await test.sendTransaction({ chain: foundry, account: deployer, data: minimalProxy(impl) });
    auction = (await pub.waitForTransactionReceipt({ hash: cloneHash })).contractAddress!;

    const now = (await pub.getBlock()).timestamp;
    await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
      address: auction, abi: SealedBidAuctionAbi, functionName: 'initialize', args: [{
        issuer: deployer.address, saleToken: sale, quoteToken: quote, totalSupply: 1000n * ONE,
        saleDecimals: 18, quoteDecimals: 18, reservePrice: ONE, tickSize: ONE / 10n, numTicks: 32,
        startTime: now, endTime: now + 3600n, revealDeadline: now + 3600n + 4n * 3600n,
        minBidQuantity: ONE, maxQuantityPerAddress: 0n, maxBids: 256,
        allowlistRoot: `0x${'0'.repeat(64)}`, protocolFeeBps: 0, feeRecipient: deployer.address,
        committeeSetId: setId, encryptionEpoch: keccak256('0x01'), metadataHash: keccak256('0x02'), voidDisputeWindow: 3600n, version: 1,
      }, registry] }) });

    for (const [tok, to, amt] of [[sale, deployer.address, 1000n * ONE], [quote, alice.address, 100_000n * ONE]] as const) {
      await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
        address: tok, abi: PermitTokenAbi, functionName: 'mint', args: [to, amt] }) });
    }
    await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
      address: sale, abi: PermitTokenAbi, functionName: 'approve', args: [auction, 1000n * ONE] }) });
    await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
      address: auction, abi: SealedBidAuctionAbi, functionName: 'fund', args: [] }) });
    await pub.waitForTransactionReceipt({ hash: await test.writeContract({ chain: foundry, account: deployer,
      address: auction, abi: SealedBidAuctionAbi, functionName: 'openCommit', args: [] }) });
  }, 120_000);

  it('detects permit support', async () => {
    expect(await supportsPermit(pub, quote)).toBe(true);
  });

  it('bids in ONE transaction with no prior approval', async () => {
    const snap = await readAuction(pub, auction);
    const bid = prepareBid({ cfg: snap.config, chainId: foundry.id, auction,
      bidder: alice.address, quantity: 10n * ONE, maxPriceTick: 5 });

    const before = (await pub.readContract({ address: quote, abi: PermitTokenAbi,
      functionName: 'allowance', args: [alice.address, auction] })) as bigint;
    expect(before).toBe(0n);

    const wallet = createWalletClient({ account: alice, chain: foundry, transport });
    const res = await submitBid({ publicClient: pub, walletClient: wallet, account: alice,
      auction, quoteToken: quote, bid, ciphertextHash: keccak256(stringToHex('ct')) });

    // The tell: no approval transaction was ever sent.
    expect(res.approvalTx).toBeUndefined();
    expect(res.bidId).toBe(0);
    expect(await pub.readContract({ address: quote, abi: PermitTokenAbi,
      functionName: 'balanceOf', args: [auction] })).toBe(bid.escrow);
  }, 60_000);

  it('the bid still lands when the permit is front-run', async () => {
    const snap = await readAuction(pub, auction);
    const bid = prepareBid({ cfg: snap.config, chainId: foundry.id, auction,
      bidder: alice.address, quantity: 12n * ONE, maxPriceTick: 4 });

    const wallet = createWalletClient({ account: alice, chain: foundry, transport });
    const permit = await signPermit({ publicClient: pub, walletClient: wallet, account: alice,
      token: quote, spender: auction, value: bid.escrow });

    // Anyone who sees the signature can burn its nonce first.
    const gw = createWalletClient({ account: griefer, chain: foundry, transport });
    await pub.waitForTransactionReceipt({ hash: await gw.writeContract({ chain: foundry,
      address: quote, abi: PermitTokenAbi, functionName: 'permit',
      args: [alice.address, auction, bid.escrow, permit.deadline, permit.v, permit.r, permit.s] }) });

    // The same signature is now spent, and the bid must go through anyway.
    const res = await submitBid({ publicClient: pub, walletClient: wallet, account: alice,
      auction, quoteToken: quote, bid, ciphertextHash: keccak256(stringToHex('ct2')) });
    expect(res.bidId).toBe(1);
  }, 60_000);
});

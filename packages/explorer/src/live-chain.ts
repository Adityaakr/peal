// The chain side of a live auction, from the browser, with no backend:
// recording the terms, and claiming the short link that resolves to them.
//
// WHY ONLY THE TERMS. An earlier design anchored every bid. Three things killed
// it. `Sealed` indexes `from` (contracts/src/PealMempool.sol:42), so one
// eth_getLogs filter would enumerate every auction a browser ever bid in.
// `commitSealed` is permissionless and writes no storage, so anyone can emit
// junk hashes under a real condition id, and code that reconciles a SET of
// commitments against a reveal reports that as a failure (verify.ts:158-163) --
// a stranger with free gas could turn the host's page red on demand. And a key
// per bid is a drain on a faucet that hands out gas to anyone who asks.
//
// Anchoring one hash, once, from the host, avoids all three. The lookup is an
// EXACT match on (conditionId, termsHash) rather than a reconciliation, so junk
// commitments under the same condition id cannot produce a false answer in
// either direction: an unrelated hash simply is not the one being asked about.
//
// WHAT IT PROVES. That these exact terms existed, in this exact form, before
// this block. It does NOT prove they were the terms anyone honoured, and it
// cannot: a forger can create their own condition and anchor their own terms.
// The defence against that is the spoken checksum, not this.
import { conditionIdToBytes32 } from 'bte-sdk';
import { isValidName, packTerms, termsHash, unpackTerms, type Terms } from 'peal-live';
import { TEMPO, fundGas } from 'peal-auctionkit';
import {
  createPublicClient, createWalletClient, decodeFunctionResult, encodeEventTopics,
  encodeFunctionData, http, stringToHex, type Hex, type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/** PealMempool on Tempo Moderato, from
 * packages/mempool-agents/deployments/42431.json. Kept in source for the same
 * reason auctionkit keeps its addresses there: a wrong address should be a
 * failing check here, not a runtime surprise in somebody's browser. */
const PEAL_MEMPOOL: Hex = '0x387b9b50950ded996776a96f20af9d2106c96bf9';

const COMMIT_SEALED = [
  {
    type: 'function',
    name: 'commitSealed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'ctHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** PealNames on Tempo Moderato, deployed 2026-09-03 in
 * 0x9d55a964032573e1bf6714b1f63860ebed26227d504edcf5553ff9894337c1d7.
 *
 * In source rather than an env var, for the reason auctionkit gives for its own
 * addresses: this is a public fact about a public chain, and a wrong value here
 * should be a failing check rather than a runtime surprise in somebody's
 * browser. It matters more here than usual, because the address IS the
 * namespace: a different one is a second, empty registry rather than the same
 * names somewhere else, so pointing this at another deployment would silently
 * stop resolving every link anyone has shared.
 *
 * The interface reads this rather than assuming a registry exists, so on a
 * chain without one the short-link field does not offer itself at all. */
const PEAL_NAMES: Hex | null = '0x98D1a8b4d8C5d36D5D9a357F7fccE17cB0F63D2f';

const NAMES_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'terms', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'isTaken',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const SEALED_EVENT = [
  {
    type: 'event',
    name: 'Sealed',
    inputs: [
      { name: 'conditionId', type: 'bytes32', indexed: true },
      { name: 'ctHash', type: 'bytes32', indexed: true },
      { name: 'from', type: 'address', indexed: true },
    ],
  },
] as const;

/** Tempo's estimator comes back about an order of magnitude low and the chain
 * rejects anything over 30M, so every write here passes an explicit limit.
 * Unused gas is not charged. Same value as auction-create.ts:322. */
const TX_GAS = 29_000_000n;

/** The RPC caps eth_getLogs at a 100k block range. Tempo produces a block
 * roughly every half second, so this trailing window covers about half a day.
 * An auction older than that is not "unanchored", it is "outside the window",
 * and the caller is told which. */
const LOG_WINDOW = 90_000n;

const publicClient = createPublicClient({ transport: http(TEMPO.rpcUrl) });

export interface TermsAnchor {
  txHash: Hex;
  blockNumber: bigint;
}

export type AnchorLookup =
  | { state: 'anchored'; anchor: TermsAnchor }
  | { state: 'absent' }
  | { state: 'out-of-window' }
  | { state: 'unreachable' };

/** A key that exists for one page load and is never persisted.
 *
 * It holds faucet gas and nothing else, it signs calls that move no value, and
 * it is gone when the page is. There is nothing here worth stealing and nothing
 * that links an auction to a person.
 *
 * One key for the whole creation rather than one per transaction: the faucet is
 * unauthenticated and per address, so a key per call is a drain on it, and two
 * calls from one key are simply sent in order.
 */
export async function fundedWallet(): Promise<WalletClient | null> {
  try {
    const account = privateKeyToAccount(generatePrivateKey());
    const funded = await fundGas(publicClient, TEMPO, account.address);
    if (!funded) return null;
    return createWalletClient({ account, transport: http(TEMPO.rpcUrl) });
  } catch {
    return null;
  }
}

/** Record the terms. Best effort by design: the caller runs this in the
 * background and the auction works whether or not it lands. */
export async function anchorTerms(
  wallet: WalletClient | null,
  terms: Terms,
): Promise<TermsAnchor | null> {
  if (!wallet?.account) return null;
  try {
    const txHash = await wallet.sendTransaction({
      account: wallet.account,
      chain: null,
      to: PEAL_MEMPOOL,
      gas: TX_GAS,
      data: encodeFunctionData({
        abi: COMMIT_SEALED,
        functionName: 'commitSealed',
        args: [await conditionIdToBytes32(terms.auctionId), await termsHash(terms)],
      }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    return receipt.status === 'success'
      ? { txHash, blockNumber: receipt.blockNumber }
      : null;
  } catch {
    // No gas, a faucet cooldown, an RPC hiccup. None of these should stop an
    // auction that is already running, so the page just says it is not anchored.
    return null;
  }
}

/** Look for this exact pair on chain. */
export async function findTermsAnchor(terms: Terms): Promise<AnchorLookup> {
  try {
    const [topic0] = encodeEventTopics({ abi: SEALED_EVENT, eventName: 'Sealed' });
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > LOG_WINDOW ? latest - LOG_WINDOW : 0n;
    const logs = await publicClient.request({
      method: 'eth_getLogs',
      params: [
        {
          address: PEAL_MEMPOOL,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: 'latest',
          topics: [topic0!, await conditionIdToBytes32(terms.auctionId), await termsHash(terms)],
        },
      ],
    } as never) as Array<{ transactionHash: Hex; blockNumber: Hex }>;

    const hit = logs[0];
    if (hit) {
      return { state: 'anchored', anchor: { txHash: hit.transactionHash, blockNumber: BigInt(hit.blockNumber) } };
    }
    // Distinguish "we looked and it is not there" from "it could be older than
    // anything we are allowed to look at", so the page never reports a stale
    // auction as tampered with.
    return terms.closeAt * 1000 < Date.now() - 12 * 3600 * 1000
      ? { state: 'out-of-window' }
      : { state: 'absent' };
  } catch {
    return { state: 'unreachable' };
  }
}

export function txUrl(hash: Hex): string {
  return `${TEMPO.explorer.replace(/\/$/, '')}/tx/${hash}`;
}

// ---- short links ---------------------------------------------------------

/** Whether a short-link registry exists on this chain yet. */
export function namesAvailable(): boolean {
  return PEAL_NAMES !== null;
}

/** Claim `name` for these terms, forever.
 *
 * The registry refuses a name that is already taken, and refuses to move one
 * that is, so this can fail for a reason the creator needs to hear rather than
 * a reason to retry. It returns a string on failure for exactly that: unlike
 * the terms record, a short link that silently did not happen would leave
 * somebody about to read a URL out on stream that resolves to nothing.
 */
export async function claimName(
  wallet: WalletClient | null,
  name: string,
  terms: Terms,
): Promise<{ txHash: Hex } | { error: string }> {
  if (!PEAL_NAMES) return { error: 'short links are not available on this network yet.' };
  if (!isValidName(name)) return { error: 'that name cannot be used.' };
  if (!wallet?.account) return { error: 'could not get gas to claim the name.' };

  try {
    const txHash = await wallet.sendTransaction({
      account: wallet.account,
      chain: null,
      to: PEAL_NAMES,
      gas: TX_GAS,
      data: encodeFunctionData({
        abi: NAMES_ABI,
        functionName: 'claim',
        args: [name, stringToHex(packTerms(terms))],
      }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    // A revert here is almost always "somebody claimed it between the check and
    // the send", which is a race no amount of checking first can close.
    return receipt.status === 'success'
      ? { txHash }
      : { error: `${name} was claimed by somebody else. pick another.` };
  } catch {
    return { error: 'could not claim that name. the auction still works from its full link.' };
  }
}

/** The terms a short link resolves to, or null if nothing claimed it.
 *
 * A read, so no key and no gas: this is what a stranger's browser runs when
 * they open peal.network/<name>.
 */
export async function resolveName(name: string): Promise<Terms | null> {
  if (!PEAL_NAMES || !isValidName(name)) return null;
  try {
    const raw = await publicClient.call({
      to: PEAL_NAMES,
      data: encodeFunctionData({ abi: NAMES_ABI, functionName: 'resolve', args: [name] }),
    });
    if (!raw.data) return null;
    const packed = decodeFunctionResult({ abi: NAMES_ABI, functionName: 'resolve', data: raw.data });
    if (!packed || packed === '0x') return null;
    // Hex bytes back to the base64url the terms codec speaks.
    const bytes = packed.slice(2).match(/.{2}/g) ?? [];
    const text = bytes.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
    // unpackTerms refuses anything that is not a link packTerms could have
    // written, so a registry entry carrying junk resolves to nothing rather
    // than to a half-formed auction.
    return unpackTerms(text);
  } catch {
    return null;
  }
}

/** Whether a name is already spoken for. Advisory: the claim is what decides,
 * and somebody can take it between this answer and that call. */
export async function isNameTaken(name: string): Promise<boolean | null> {
  if (!PEAL_NAMES || !isValidName(name)) return null;
  try {
    const raw = await publicClient.call({
      to: PEAL_NAMES,
      data: encodeFunctionData({ abi: NAMES_ABI, functionName: 'isTaken', args: [name] }),
    });
    if (!raw.data) return null;
    return decodeFunctionResult({ abi: NAMES_ABI, functionName: 'isTaken', data: raw.data });
  } catch {
    return null;
  }
}

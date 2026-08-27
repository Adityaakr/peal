/** EIP-2612 permit: turning an approval into a signature.
 *
 * Bidding used to cost two transactions and two wallet prompts, an `approve`
 * and then a `commitBid`. The second prompt is where people stop, and on a
 * twelve second chain the extra transaction is most of the wait a bidder
 * actually feels. A permit replaces the first with an offchain signature, so
 * the whole thing becomes one transaction and one prompt.
 *
 * Not every token implements it. `supportsPermit` asks the chain rather than
 * assuming, and the caller falls back to the approve path when the answer is
 * no. Guessing wrong in either direction produces a failed transaction the
 * bidder pays for.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { PermitTokenAbi } from './abi.js';

/** Does this token implement EIP-2612?
 *
 * Probed by calling `nonces`, which permit requires and which a plain ERC-20
 * does not have. A revert means no permit, which is an answer rather than an
 * error, so it is caught rather than propagated. */
export async function supportsPermit(client: PublicClient, token: Address): Promise<boolean> {
  try {
    await client.readContract({
      address: token,
      abi: PermitTokenAbi,
      functionName: 'nonces',
      args: ['0x0000000000000000000000000000000000000000'],
    });
    return true;
  } catch {
    return false;
  }
}

export interface SignedPermit {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Sign a permit for `spender` to move `value` of `token`.
 *
 * The domain is read from the token itself through `eip712Domain`, not
 * assembled from assumptions. A token's permit domain uses whatever name and
 * version it was deployed with, and a mismatch produces a signature that
 * recovers to the wrong address and a permit that silently fails.
 */
export async function signPermit(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account | Address;
  token: Address;
  spender: Address;
  value: bigint;
  /** Seconds from now. Short by default: a permit is a standing authorisation
   * to move funds, and one that lasts a week is one a compromised signature
   * can use a week from now. */
  ttlSeconds?: bigint;
}): Promise<SignedPermit> {
  const owner = typeof args.account === 'string' ? args.account : args.account.address;

  const [nonce, domain] = await Promise.all([
    args.publicClient.readContract({
      address: args.token,
      abi: PermitTokenAbi,
      functionName: 'nonces',
      args: [owner],
    }) as Promise<bigint>,
    readDomain(args.publicClient, args.token),
  ]);

  const block = await args.publicClient.getBlock();
  const deadline = block.timestamp + (args.ttlSeconds ?? 1800n);

  const signature = await args.walletClient.signTypedData({
    account: args.account,
    domain,
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner, spender: args.spender, value: args.value, nonce, deadline },
  });

  // Split into v, r, s because the contract takes them separately, which is
  // what EIP-2612 specifies.
  const raw = signature.slice(2);
  return {
    deadline,
    r: `0x${raw.slice(0, 64)}` as Hex,
    s: `0x${raw.slice(64, 128)}` as Hex,
    v: parseInt(raw.slice(128, 130), 16),
  };
}

async function readDomain(
  client: PublicClient,
  token: Address,
): Promise<{ name: string; version: string; chainId: number; verifyingContract: Address }> {
  const d = (await client.readContract({
    address: token,
    abi: PermitTokenAbi,
    functionName: 'eip712Domain',
  })) as [Hex, string, string, bigint, Address, Hex, bigint[]];
  return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
}

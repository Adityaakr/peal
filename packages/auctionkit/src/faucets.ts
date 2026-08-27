/** Getting a new account usable, entirely from the browser.
 *
 * Three things are needed and they have to happen in order, because the first
 * one gates the other two: gas, then the payment token, then the sale token.
 *
 * The gas step is the interesting one. On a chain that charges gas in an ERC-20,
 * a new wallet holds nothing and therefore cannot send a transaction, including
 * the transaction that would claim from a faucet. That circle is normally broken
 * by a funding service holding a key, which means a backend and a key worth
 * stealing. Tempo exposes `tempo_fundAddress` as a plain RPC call instead, so
 * the browser can break it directly with no key and no server.
 */
import { type Address, type PublicClient, type WalletClient, type Account, type Hex } from 'viem';
import { DemoFaucetAbi } from './abi.js';
import type { Deployment } from './addresses.js';

export interface FaucetStep {
  id: 'gas' | 'quote' | 'sale';
  label: string;
  done: boolean;
  /** Set when the step ran and failed, so a partial result is still legible. */
  error?: string;
  hash?: Hex;
}

/** Ask the chain to fund gas, and wait until it has actually arrived.
 *
 * Returns false when the chain has no such method, which is not an error: most
 * chains do not, and their users already hold gas.
 *
 * The wait is the important part. The RPC returns as soon as the transactions
 * are submitted, not once they are mined, so a caller that proceeds
 * immediately tries to claim tokens from an account that still has no gas and
 * fails on every one. Polling the balance is what makes "then claim" safe to
 * write. */
export async function fundGas(
  client: PublicClient,
  d: Deployment,
  address: Address,
  opts: { gasToken?: Address; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!d.gasFaucetRpcMethod) return false;
  await client.request({ method: d.gasFaucetRpcMethod, params: [address.toLowerCase()] } as never);

  const token = opts.gasToken ?? d.gasToken;
  if (!token) return true;

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const bal = (await client.readContract({
      address: token,
      abi: [{
        type: 'function', name: 'balanceOf', stateMutability: 'view',
        inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }],
      }],
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
    if (bal > 0n) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return true;
}

/** Claim from one of the token faucets. */
export async function claimFrom(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account | Address;
  chain: WalletClient['chain'];
  faucet: Address;
  amount: bigint;
  /** Tempo rejects a transaction above 30M gas and estimates an order of
   * magnitude low, so a caller on that chain passes an explicit limit. */
  gas?: bigint;
}): Promise<Hex> {
  return args.walletClient.writeContract({
    chain: args.chain,
    account: args.account,
    address: args.faucet,
    abi: DemoFaucetAbi,
    functionName: 'claim',
    args: [args.amount],
    ...(args.gas ? { gas: args.gas } : {}),
  });
}

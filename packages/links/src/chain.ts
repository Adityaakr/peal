// The backing chain, through the person's own wallet: token balance and
// allowance reads, the deposit (approve + gateway.deposit), and submitting a
// certified withdrawal. Every write is a transaction the wallet confirms;
// the SDK never holds a chain key.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import type { NamespaceInfo, WithdrawalCertificate } from './client.js';

export const GATEWAY_ABI = parseAbi([
  'function deposit(address token, uint256 amount, bytes32 receipt) returns (uint256 id)',
  'function withdraw((uint256 chainId,address gateway,address token,address recipient,uint256 amount,bytes32 withdrawalId,uint64 epoch) w, bytes[] signatures)',
  'function epoch() view returns (uint64)',
  'function consumed(bytes32 id) view returns (bool)',
  'function paused() view returns (bool)',
  'event Deposit(uint256 indexed id, address indexed token, address indexed from, uint256 amount, bytes32 receipt)',
  'event Withdrawn(bytes32 indexed withdrawalId, address indexed token, address indexed recipient, uint256 amount, uint64 epoch)',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function faucet(address to, uint256 amount)',
]);

function chainFor(ns: NamespaceInfo) {
  return {
    id: ns.chain_id,
    name: ns.chain_name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] as string[] } },
  };
}

/** Read-only access through the wallet's provider (or an RPC URL). */
export function publicClientFor(ns: NamespaceInfo, provider?: EIP1193Provider, rpcUrl?: string) {
  return createPublicClient({
    chain: chainFor(ns),
    transport: provider ? custom(provider) : http(rpcUrl),
  });
}

export async function tokenBalance(ns: NamespaceInfo, owner: Address, provider?: EIP1193Provider, rpcUrl?: string): Promise<bigint> {
  const pc = publicClientFor(ns, provider, rpcUrl);
  return pc.readContract({ address: ns.token_address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

/** Chains whose gas estimator is unreliable get an explicit limit. Tempo
 * estimates about an order of magnitude low and rejects anything above
 * 30M; unused gas is not charged. */
export const TX_GAS: Record<number, bigint> = { 42431: 29_000_000n };

/** Chains whose gas is an ERC-20 the chain itself hands out through an RPC
 * method: `tempo_fundAddress` on Tempo Moderato. */
const GAS_FAUCET: Record<number, { method: string; token: Address }> = {
  42431: { method: 'tempo_fundAddress', token: '0x20c0000000000000000000000000000000000000' },
};

export function gasSymbol(chainId: number): string {
  return chainId === 42431 ? 'PathUSD' : 'ETH';
}

/** Make sure `address` can pay gas on the namespace's chain. A no-op on
 * chains without a gas faucet; on Tempo it asks the chain to fund the
 * address and waits until the gas token arrived. Returns whether the
 * faucet was used. */
export async function ensureGas(ns: NamespaceInfo, address: Address): Promise<boolean> {
  const faucet = GAS_FAUCET[ns.chain_id];
  if (!faucet || !ns.rpc_url) return false;
  const pc = publicClientFor(ns, undefined, ns.rpc_url);
  const balance = () => pc.readContract({ address: faucet.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
  if ((await balance()) > 0n) return false;
  await pc.request({ method: faucet.method as 'eth_chainId', params: [address.toLowerCase()] as never });
  for (let i = 0; i < 20; i++) {
    if ((await balance()) > 0n) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('the chain did not fund gas for this wallet in time');
}

export interface DepositTx {
  approveHash: Hex | null;
  depositHash: Hex;
}

/** Approve (if needed) and deposit `amount` base units for `receipt`. The
 * receipt is the ledger's canonical 32-byte encoding, carried as bytes32. */
export async function depositOnChain(ns: NamespaceInfo, provider: EIP1193Provider, from: Address, amount: bigint, receiptHex: string): Promise<DepositTx> {
  const chain = chainFor(ns);
  const wc = createWalletClient({ account: from, chain, transport: custom(provider) });
  const pc = createPublicClient({ chain, transport: custom(provider) });
  const token = ns.token_address as Address;
  const gateway = ns.gateway as Address;
  const allowance = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [from, gateway] });
  let approveHash: Hex | null = null;
  if (allowance < amount) {
    approveHash = await wc.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [gateway, amount], gas: TX_GAS[ns.chain_id] });
    await pc.waitForTransactionReceipt({ hash: approveHash });
  }
  const receipt = `0x${receiptHex}` as Hex;
  const depositHash = await wc.writeContract({ address: gateway, abi: GATEWAY_ABI, functionName: 'deposit', args: [token, amount, receipt], gas: TX_GAS[ns.chain_id] });
  await pc.waitForTransactionReceipt({ hash: depositHash });
  return { approveHash, depositHash };
}

/** Submit a certified withdrawal to the gateway. Anyone may submit; the
 * tokens go to the certificate's recipient regardless of who pays gas. */
export async function withdrawOnChain(ns: NamespaceInfo, provider: EIP1193Provider, from: Address, cert: WithdrawalCertificate): Promise<Hex> {
  const chain = chainFor(ns);
  const wc = createWalletClient({ account: from, chain, transport: custom(provider) });
  const pc = createPublicClient({ chain, transport: custom(provider) });
  const m = cert.message;
  const hash = await wc.writeContract({
    address: ns.gateway as Address,
    abi: GATEWAY_ABI,
    functionName: 'withdraw',
    args: [
      {
        chainId: BigInt(m.chain_id),
        gateway: m.gateway as Address,
        token: m.token as Address,
        recipient: m.recipient as Address,
        amount: BigInt(m.amount),
        withdrawalId: `0x${m.withdrawal_id}` as Hex,
        epoch: BigInt(m.epoch),
      },
      cert.signatures as Hex[],
    ],
    gas: TX_GAS[ns.chain_id],
  });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

/** Where a tester gets the namespace's asset, on non-mainnet namespaces:
 * the chain's own gas faucet when the asset is the gas token, the test
 * token's public `faucet` function, or an external page (Circle's faucet
 * for testnet USDC). Null on mainnet or when nothing is known. */
export function testFundsSource(ns: NamespaceInfo): { kind: 'chain-faucet' } | { kind: 'token-faucet' } | { kind: 'external'; url: string } | null {
  if (ns.environment === 'mainnet') return null;
  const gas = GAS_FAUCET[ns.chain_id];
  if (gas && gas.token.toLowerCase() === ns.token_address.toLowerCase()) return { kind: 'chain-faucet' };
  if (ns.token_symbol === 'tUSD') return { kind: 'token-faucet' };
  if (ns.token_symbol === 'USDC') return { kind: 'external', url: 'https://faucet.circle.com' };
  return null;
}

/** Get test funds for `address` from the source `testFundsSource` names.
 * Returns what was done, for the interface. */
export async function claimTestFunds(ns: NamespaceInfo, provider: EIP1193Provider, address: Address): Promise<'chain-faucet' | 'token-faucet'> {
  const source = testFundsSource(ns);
  if (!source || source.kind === 'external') throw new Error('no faucet the app can call for this asset');
  if (source.kind === 'chain-faucet') {
    const faucet = GAS_FAUCET[ns.chain_id]!;
    const pc = publicClientFor(ns, undefined, ns.rpc_url);
    const before = await pc.readContract({ address: faucet.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
    await pc.request({ method: faucet.method as 'eth_chainId', params: [address.toLowerCase()] as never });
    for (let i = 0; i < 20; i++) {
      if ((await pc.readContract({ address: faucet.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })) > before) return 'chain-faucet';
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('the chain did not fund this wallet in time');
  }
  await ensureGas(ns, address);
  await faucet(ns, provider, address, address, 1_000n * 10n ** BigInt(ns.decimals));
  return 'token-faucet';
}

/** Local and test chains only: mint test tokens from the faucet. */
export async function faucet(ns: NamespaceInfo, provider: EIP1193Provider, from: Address, to: Address, amount: bigint): Promise<Hex> {
  if (ns.environment === 'mainnet') throw new Error('no faucet on a mainnet namespace');
  const chain = chainFor(ns);
  const wc = createWalletClient({ account: from, chain, transport: custom(provider) });
  const pc = createPublicClient({ chain, transport: custom(provider) });
  const hash = await wc.writeContract({ address: ns.token_address as Address, abi: ERC20_ABI, functionName: 'faucet', args: [to, amount], gas: TX_GAS[ns.chain_id] });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

// EIP-712 records the connected wallet signs (decisions 0011 and 0012):
// the receiving profile (the account authorization published to the
// directory), the local payment intent (verified here, never transmitted),
// and the fixed recovery message. The node carries the same profile type
// string in `crates/peal-links-node/src/directory.rs`; a drift between the
// two makes the node's recovery produce the wrong address and refuse the
// profile, so the two cannot silently disagree.

import {
  createWalletClient,
  custom,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export const LINKS_DOMAIN_NAME = 'Peal Links';
export const LINKS_DOMAIN_VERSION = '1';

export function linksDomain(chainId: number): TypedDataDomain {
  return { name: LINKS_DOMAIN_NAME, version: LINKS_DOMAIN_VERSION, chainId };
}

export const PROFILE_TYPES = {
  PealLinksAccount: [
    { name: 'version', type: 'uint64' },
    { name: 'wallet', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'namespace', type: 'bytes32' },
    { name: 'account', type: 'bytes32' },
    { name: 'encKey', type: 'bytes32' },
    { name: 'profileKey', type: 'bytes32' },
    { name: 'displayName', type: 'string' },
    { name: 'recovery', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'prev', type: 'bytes32' },
    { name: 'revoked', type: 'bool' },
  ],
} as const;

export type RecoveryMechanism = 'wallet-signature' | 'recovery-code';

/** A signed receiving profile, exactly as the directory stores it. */
export interface Profile {
  version: number;
  /** Lowercase 0x address. */
  wallet: string;
  chain_id: number;
  namespace: string;
  account: string;
  enc_key: string;
  profile_key: string;
  display_name: string;
  recovery: RecoveryMechanism;
  nonce: string;
  issued_at: number;
  expiry: number;
  prev: string;
  revoked: boolean;
  signature: string;
}

export type UnsignedProfile = Omit<Profile, 'signature'>;

const h32 = (s: string): Hex => {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-f]{64}$/i.test(clean)) throw new Error('expected 32 hex bytes');
  return `0x${clean.toLowerCase()}`;
};

export function profileTypedData(p: UnsignedProfile) {
  return {
    domain: linksDomain(p.chain_id),
    types: PROFILE_TYPES,
    primaryType: 'PealLinksAccount' as const,
    message: {
      version: BigInt(p.version),
      wallet: p.wallet as Address,
      chainId: BigInt(p.chain_id),
      namespace: h32(p.namespace),
      account: h32(p.account),
      encKey: h32(p.enc_key),
      profileKey: h32(p.profile_key),
      displayName: p.display_name,
      recovery: p.recovery,
      nonce: h32(p.nonce),
      issuedAt: BigInt(p.issued_at),
      expiry: BigInt(p.expiry),
      prev: h32(p.prev),
      revoked: p.revoked,
    },
  };
}

/** The EIP-712 digest: the profile's identity in the directory log. */
export function profileHash(p: UnsignedProfile): string {
  return hashTypedData(profileTypedData(p)).slice(2);
}

/** Verify a profile's signature against the wallet it names. An externally
 * owned account verifies by recovery; with a public client, a contract
 * wallet verifies through ERC-1271 (viem handles ERC-6492 as well). */
export async function verifyProfile(p: Profile, publicClient?: PublicClient): Promise<boolean> {
  const typed = profileTypedData(p);
  const sig = p.signature as Hex;
  try {
    const recovered = await recoverTypedDataAddress({ ...typed, signature: sig });
    if (recovered.toLowerCase() === p.wallet.toLowerCase()) return true;
  } catch {
    /* not an EOA signature */
  }
  if (!publicClient) return false;
  try {
    return await publicClient.verifyTypedData({ ...typed, address: p.wallet as Address, signature: sig });
  } catch {
    return false;
  }
}

export const PAYMENT_INTENT_TYPES = {
  PealLinksPaymentIntent: [
    { name: 'amount', type: 'uint256' },
    { name: 'recipientProfileHash', type: 'bytes32' },
    { name: 'requestId', type: 'string' },
    { name: 'namespace', type: 'bytes32' },
    { name: 'accountStateVersion', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** What the payer's wallet confirms before a payment is proven. Local: the
 * signature is checked here and never leaves the device. */
export interface PaymentIntent {
  amount: string;
  recipient_profile_hash: string;
  request_id: string;
  namespace: string;
  account_state_version: number;
  nonce: string;
  expiry: number;
}

export function paymentIntentTypedData(i: PaymentIntent, chainId: number) {
  return {
    domain: linksDomain(chainId),
    types: PAYMENT_INTENT_TYPES,
    primaryType: 'PealLinksPaymentIntent' as const,
    message: {
      amount: BigInt(i.amount),
      recipientProfileHash: h32(i.recipient_profile_hash),
      requestId: i.request_id,
      namespace: h32(i.namespace),
      accountStateVersion: BigInt(i.account_state_version),
      nonce: h32(i.nonce),
      expiry: BigInt(i.expiry),
    },
  };
}

export async function verifyPaymentIntent(
  i: PaymentIntent,
  chainId: number,
  signature: Hex,
  address: string,
  publicClient?: PublicClient,
): Promise<boolean> {
  if (i.expiry * 1000 < Date.now()) return false;
  const typed = paymentIntentTypedData(i, chainId);
  try {
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    if (recovered.toLowerCase() === address.toLowerCase()) return true;
  } catch {
    /* not an EOA signature */
  }
  if (!publicClient) return false;
  try {
    return await publicClient.verifyTypedData({ ...typed, address: address as Address, signature });
  } catch {
    return false;
  }
}

/** The fixed, domain-bound message whose (deterministic) signature derives
 * the backup key (decision 0012). Names Peal and the purpose in plain words
 * so a phishing prompt reads as what it is. */
export function recoveryMessage(address: string, namespaceLabel: string, namespaceId: string): string {
  return [
    'Peal Links recovery key',
    '',
    'Signing this message lets Peal Links derive the key that protects the encrypted backup of your private payments account. Only sign it on the Peal Links site you opened yourself.',
    '',
    `Wallet: ${address.toLowerCase()}`,
    `Asset domain: ${namespaceLabel}`,
    `Ledger: ${namespaceId}`,
    'Purpose: peal-links/v1/backup-key',
  ].join('\n');
}

/** What the SDK needs from a wallet: typed-data and message signatures. */
export interface WalletSigner {
  address: string;
  chainId: number;
  signTypedData(typed: { domain: TypedDataDomain; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

/** A signer over an injected EIP-1193 provider (a browser wallet). */
export function providerSigner(provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, address: string, chainId: number): WalletSigner {
  const wc = createWalletClient({ transport: custom(provider) });
  return {
    address: address.toLowerCase(),
    chainId,
    signTypedData: (typed) =>
      wc.signTypedData({
        account: address as Address,
        domain: typed.domain,
        types: typed.types as Record<string, { name: string; type: string }[]>,
        primaryType: typed.primaryType,
        message: typed.message,
      }),
    signMessage: (message) => wc.signMessage({ account: address as Address, message }),
  };
}

/** A signer over a viem local account (tests, scripts). */
export function localSigner(account: PrivateKeyAccount, chainId: number): WalletSigner {
  return {
    address: account.address.toLowerCase(),
    chainId,
    signTypedData: (typed) =>
      account.signTypedData({
        domain: typed.domain,
        types: typed.types as Record<string, { name: string; type: string }[]>,
        primaryType: typed.primaryType,
        message: typed.message,
      }),
    signMessage: (message) => account.signMessage({ message }),
  };
}

export function randomHex32(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

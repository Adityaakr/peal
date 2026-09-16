// The Peal Links node API as the explorer sees it.
//
// Every page under #/bonsai and #/pay reads through this module and nothing
// else: there is no fixture data path. When the node is not running the
// pages say so, with the command that starts it, rather than showing numbers
// that are not real. The SDK package (packages/links) grows out of this file
// in Phase C; the shapes below are the wire contract the node serves.
//
// Money is a decimal string of base units on the wire, never a float.

const BASE: string = (import.meta.env.VITE_LINKS_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
const PREFIX = `${BASE}/links/v1`;

/** One asset domain: a chain, a token, a gateway and a ledger namespace. */
export interface NamespaceInfo {
  /** 32-byte namespace id, hex. */
  id: string;
  /** Human label, e.g. "local-a / tUSD". */
  label: string;
  chain_id: number;
  chain_name: string;
  token_symbol: string;
  token_address: string;
  decimals: number;
  gateway: string;
  /** Operational for deposits and withdrawals right now. Configured is not
   * available: a mainnet profile with no verified deployment is `false`. */
  available: boolean;
  /** Blocks (or L2 policy) before a deposit is credited. */
  confirmations: number;
  /** `local`, `testnet` or `mainnet`. Drives the demo-funds labelling. */
  environment: 'local' | 'testnet' | 'mainnet';
}

export interface LinksStatus {
  ok: boolean;
  version: string;
  circuit_id: string;
  /** How the proving keys were made. */
  setup: 'local-dev' | 'ceremony';
  /** `single-node` is a development mode, never a decentralised claim. */
  ledger_mode: string;
  consensus: null | { validator: string; validators: string[]; height: number; head: string; state_root: string };
  namespaces: NamespaceInfo[];
  ledgers: Array<{ namespace: string; seq: number; receipt_count: number; state_root: string; receipt_root: string }>;
}

/** The signed request manifest a payer verifies before paying. */
export interface RequestManifest {
  version: 1;
  request_id: string;
  namespace: string;
  /** Receiver account id, canonical hex field element. */
  receiver_account: string;
  /** Receiver's receipt encryption public key (x25519), hex. */
  receiver_enc_key: string;
  /** Exact amount in base units, decimal string. */
  amount: string;
  title: string;
  display_name: string;
  reference: string | null;
  expires_at: number | null;
  created_at: number;
  /** ed25519 over the canonical manifest bytes, by the receiver's spend key. */
  signer_pubkey: string;
  signature: string;
}

export type RequestStatus = 'active' | 'reserved' | 'fulfilled' | 'expired' | 'archived';

export interface PaymentRequest {
  manifest: RequestManifest;
  status: RequestStatus;
  /** Set when the receiver has acknowledged a claimed payment for this
   * request. Optional, receiver-signed; absence is not evidence. */
  fulfilled_at: number | null;
}

export class LinksApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${PREFIX}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
  }
  if (!res.ok) {
    // The node always answers JSON. A non-JSON error is the edge or the dev
    // proxy speaking for a node that is not there (vite answers 500 on
    // ECONNREFUSED, Caddy 502), and the honest reading is "unreachable".
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (!isJson || res.status === 502 || res.status === 503 || res.status === 504) {
      throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
    }
    let code = 'error';
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { code?: string; detail?: string; title?: string };
      code = body.code ?? code;
      message = body.detail ?? body.title ?? message;
    } catch {
      /* not json */
    }
    throw new LinksApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function getStatus(): Promise<LinksStatus> {
  return call<LinksStatus>('/status');
}

export function getRequest(id: string): Promise<PaymentRequest> {
  return call<PaymentRequest>(`/requests/${encodeURIComponent(id)}`);
}

/** Request ids are 24 lowercase base32 characters (120 bits of randomness),
 * which is also the shape the edge accepts as a nested path. */
export const REQUEST_ID = /^[a-z2-7]{24}$/;

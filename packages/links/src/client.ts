// Typed client for the Peal Links node (`/links/v1`).
//
// Money is a decimal string of base units everywhere on this boundary.
// Errors are `LinksApiError` with the node's stable `code`; a node that is
// not there (network error, proxy 5xx without JSON) is `code: 'unreachable'`
// with status 0, so a page can tell "down" from "refused".

export interface NamespaceInfo {
  id: string;
  label: string;
  chain_id: number;
  chain_name: string;
  token_symbol: string;
  token_address: string;
  decimals: number;
  gateway: string;
  available: boolean;
  confirmations: number;
  environment: 'local' | 'testnet' | 'mainnet';
  explorer_url: string;
}

export interface LedgerInfo {
  namespace: string;
  seq: number;
  receipt_count: number;
  state_root: string;
  receipt_root: string;
}

export interface LinksStatus {
  ok: boolean;
  version: string;
  circuit_id: string;
  setup: 'local-dev' | 'ceremony';
  ledger_mode: 'single-node' | 'multi-node';
  dev_mint: boolean;
  /** `single-process-fixture`: every settlement signer key is held by the
   * node (local demo). `none`: no withdrawals. */
  signer_mode: 'single-process-fixture' | 'none';
  signers: string[];
  signer_threshold: number;
  namespaces: NamespaceInfo[];
  ledgers: LedgerInfo[];
}

export interface ParamsIndex {
  circuit_id: string;
  setup: string;
  files: Record<string, { digest: string; size: number }>;
}

export interface LedgerSummary extends LedgerInfo {
  recent_roots: string[];
  minted_total: string;
}

export interface AccountView {
  account: string;
  com: string;
  updated_seq: number;
}

export interface Applied {
  seq: number;
  position: number | null;
  receipt_root: string;
  state_root: string;
}

export interface ReceiptPath {
  position: number;
  size: number;
  root: string;
  leaf: string;
  siblings: string[];
  index_bits: boolean[];
}

export interface HistoryOp {
  seq: number;
  kind: 'register' | 'op' | 'mint';
  envelope: { account?: string; [k: string]: unknown };
  position: number | null;
}

export interface RequestManifest {
  version: 1;
  request_id: string;
  namespace: string;
  receiver_account: string;
  receiver_enc_key: string;
  amount: string;
  title: string;
  display_name: string;
  reference: string | null;
  expires_at: number | null;
  created_at: number;
  signer_pubkey: string;
  signature: string;
}

export type RequestStatus = 'active' | 'fulfilled' | 'expired' | 'archived';

export interface PaymentRequest {
  manifest: RequestManifest;
  status: RequestStatus;
  fulfilled_at: number | null;
  /** Another payer is at checkout right now (soft lock, ten minutes). */
  reserved: boolean;
}

export interface InboxItem {
  id: number;
  envelope: unknown;
  request_id: string | null;
  posted_at: number;
}

export interface WithdrawalCertificate {
  message: {
    chain_id: number;
    gateway: string;
    token: string;
    recipient: string;
    amount: string;
    withdrawal_id: string;
    epoch: number;
  };
  signatures: string[];
  signers: string[];
  threshold: number;
}

export interface WithdrawalStatus extends WithdrawalCertificate {
  position: number;
  status: 'certificate_ready' | 'confirmed';
  tx_hash: string | null;
  recipient: string;
  amount: string;
}

export interface SessionInfo {
  token: string;
  address: string;
  expires_at: number;
}

export class LinksApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LinksApiError';
  }
}

export interface NodeClientOptions {
  /** Origin of the node, or '' for same-origin through a proxy. */
  baseUrl?: string;
  /** Session token for authenticated product calls. */
  token?: string | null;
  fetch?: typeof fetch;
}

export class NodeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  token: string | null;

  constructor(opts: NodeClientOptions = {}) {
    this.base = `${(opts.baseUrl ?? '').replace(/\/+$/, '')}/links/v1`;
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
    if (init.body !== undefined && !(init.body instanceof Uint8Array)) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    } catch {
      throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
    }
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json') || res.status === 502 || res.status === 503 || res.status === 504) {
        throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
      }
      const body = (await res.json()) as { code?: string; detail?: string; title?: string };
      throw new LinksApiError(res.status, body.code ?? 'error', body.detail ?? body.title ?? `${res.status}`);
    }
    if (init.raw) return (await res.arrayBuffer()) as unknown as T;
    return (await res.json()) as T;
  }

  private post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.call<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
  }

  // ---- status and params

  status(): Promise<LinksStatus> {
    return this.call('/status');
  }

  params(): Promise<ParamsIndex> {
    return this.call('/params');
  }

  /** Download one parameter file and check its digest against the index. */
  async paramFile(name: string, expectedDigest: string): Promise<Uint8Array> {
    const buf = await this.call<ArrayBuffer>(`/params/${name}`, { raw: true, headers: { accept: 'application/octet-stream' } });
    const bytes = new Uint8Array(buf);
    const digest = await sha256Hex(bytes);
    if (digest !== expectedDigest) throw new LinksApiError(0, 'digest_mismatch', `parameter file ${name} does not match its digest`);
    return bytes;
  }

  // ---- ledger

  ledger(ns: string): Promise<LedgerSummary> {
    return this.call(`/ledger/${ns}`);
  }

  async account(ns: string, account: string): Promise<AccountView | null> {
    try {
      return await this.call(`/ledger/${ns}/accounts/${account}`);
    } catch (e) {
      if (e instanceof LinksApiError && e.code === 'unknown_account') return null;
      throw e;
    }
  }

  register(ns: string, envelope: unknown): Promise<Applied> {
    return this.post(`/ledger/${ns}/register`, envelope);
  }

  apply(ns: string, envelope: unknown): Promise<Applied> {
    return this.post(`/ledger/${ns}/ops`, envelope);
  }

  /** The public operation log (registrations, mints, ops), from `from`. */
  history(ns: string, from = 1, limit = 100): Promise<{ ops: HistoryOp[] }> {
    return this.call(`/ledger/${ns}/history?from=${from}&limit=${limit}`);
  }

  receiptPath(ns: string, position: number, size?: number): Promise<ReceiptPath> {
    const q = size !== undefined ? `?size=${size}` : '';
    return this.call(`/ledger/${ns}/receipts/${position}/path${q}`);
  }

  // ---- auth

  nonce(): Promise<{ nonce: string; expires_at: number }> {
    return this.call('/auth/nonce');
  }

  async session(message: string, signature: string): Promise<SessionInfo> {
    const s = await this.post<SessionInfo>('/auth/session', { message, signature });
    this.token = s.token;
    return s;
  }

  me(): Promise<{ address: string; chain_id: number }> {
    return this.call('/auth/me');
  }

  // ---- requests

  createRequest(manifest: RequestManifest): Promise<PaymentRequest> {
    return this.post('/requests', manifest);
  }

  listRequests(): Promise<{ requests: PaymentRequest[] }> {
    return this.call('/requests');
  }

  getRequest(id: string): Promise<PaymentRequest> {
    return this.call(`/requests/${encodeURIComponent(id)}`);
  }

  archiveRequest(id: string): Promise<{ ok: true }> {
    return this.post(`/requests/${encodeURIComponent(id)}/archive`, {});
  }

  reserveRequest(id: string, intentId: string): Promise<{ reserved_until: number }> {
    return this.post(`/requests/${encodeURIComponent(id)}/reserve`, { intent_id: intentId });
  }

  fulfillRequest(id: string, ack: unknown): Promise<{ ok: true }> {
    return this.post(`/requests/${encodeURIComponent(id)}/fulfill`, ack);
  }

  // ---- inbox

  bindKey(binding: unknown): Promise<{ ok: true }> {
    return this.post('/inbox/keys', binding);
  }

  async keyBinding(ns: string, account: string): Promise<unknown | null> {
    try {
      return await this.call(`/inbox/keys/${ns}/${account}`);
    } catch (e) {
      if (e instanceof LinksApiError && e.code === 'no_key') return null;
      throw e;
    }
  }

  postInbox(ns: string, account: string, envelope: unknown, requestId?: string | null): Promise<{ id: number }> {
    return this.post(`/inbox/${ns}/${account}`, { envelope, request_id: requestId ?? null });
  }

  inbox(ns: string, account: string, authJson: string, after = 0): Promise<{ items: InboxItem[] }> {
    return this.call(`/inbox/${ns}/${account}?after=${after}`, { headers: { 'x-peal-inbox-auth': authJson } });
  }

  // ---- deposits

  registerDepositIntent(intent: unknown): Promise<{ receipt: string; status: string }> {
    return this.post('/deposits/intents', intent);
  }

  depositIntent(ns: string, receipt: string): Promise<{ receipt: string; status: string; deposit_id: string | null; position: number | null }> {
    return this.call(`/deposits/intents/${ns}/${receipt}`);
  }

  // ---- withdrawals

  /** Submit a signed withdrawal disclosure; returns the committee certificate. */
  settleWithdrawal(claim: unknown): Promise<WithdrawalCertificate> {
    return this.post('/withdrawals', claim);
  }

  withdrawal(ns: string, position: number): Promise<WithdrawalStatus> {
    return this.call(`/withdrawals/${ns}/${position}`);
  }

  accounting(ns: string): Promise<{ minted_total: string; withdrawn_total: string; outstanding_liability: string; receipt_count: number }> {
    return this.call(`/ledger/${ns}/accounting`);
  }

  /** DEVELOPMENT FIXTURE: only exists when the node runs with dev_mint. */
  devMint(ns: string, receipt: string): Promise<Applied> {
    return this.post('/dev/mint', { namespace: ns, receipt });
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build the EIP-4361 message the wallet signs for a session. */
export function siweMessage(opts: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  statement?: string;
  issuedAt?: Date;
  expiresInSeconds?: number;
}): string {
  const issued = opts.issuedAt ?? new Date();
  const exp = new Date(issued.getTime() + (opts.expiresInSeconds ?? 600) * 1000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const statement = opts.statement ?? 'Sign in to Peal Links.';
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    '',
    statement,
    '',
    `URI: ${opts.uri}`,
    'Version: 1',
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${iso(issued)}`,
    `Expiration Time: ${iso(exp)}`,
  ].join('\n');
}

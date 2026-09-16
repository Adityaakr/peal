# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: links-edge.spec.ts >> wallet rejection and wrong network are recoverable, not silent
- Location: e2e/links-edge.spec.ts:134:1

# Error details

```
LinksApiError: the Peal Links node is not reachable
```

# Test source

```ts
  87  | export interface RequestManifest {
  88  |   version: 1;
  89  |   request_id: string;
  90  |   namespace: string;
  91  |   receiver_account: string;
  92  |   receiver_enc_key: string;
  93  |   amount: string;
  94  |   title: string;
  95  |   display_name: string;
  96  |   reference: string | null;
  97  |   expires_at: number | null;
  98  |   created_at: number;
  99  |   signer_pubkey: string;
  100 |   signature: string;
  101 | }
  102 | 
  103 | export type RequestStatus = 'active' | 'fulfilled' | 'expired' | 'archived';
  104 | 
  105 | export interface PaymentRequest {
  106 |   manifest: RequestManifest;
  107 |   status: RequestStatus;
  108 |   fulfilled_at: number | null;
  109 |   /** Another payer is at checkout right now (soft lock, ten minutes). */
  110 |   reserved: boolean;
  111 | }
  112 | 
  113 | export interface InboxItem {
  114 |   id: number;
  115 |   envelope: unknown;
  116 |   request_id: string | null;
  117 |   posted_at: number;
  118 | }
  119 | 
  120 | export interface WithdrawalCertificate {
  121 |   message: {
  122 |     chain_id: number;
  123 |     gateway: string;
  124 |     token: string;
  125 |     recipient: string;
  126 |     amount: string;
  127 |     withdrawal_id: string;
  128 |     epoch: number;
  129 |   };
  130 |   signatures: string[];
  131 |   signers: string[];
  132 |   threshold: number;
  133 | }
  134 | 
  135 | export interface WithdrawalStatus extends WithdrawalCertificate {
  136 |   position: number;
  137 |   status: 'certificate_ready' | 'confirmed';
  138 |   tx_hash: string | null;
  139 |   recipient: string;
  140 |   amount: string;
  141 | }
  142 | 
  143 | export interface SessionInfo {
  144 |   token: string;
  145 |   address: string;
  146 |   expires_at: number;
  147 | }
  148 | 
  149 | export class LinksApiError extends Error {
  150 |   constructor(
  151 |     public readonly status: number,
  152 |     public readonly code: string,
  153 |     message: string,
  154 |   ) {
  155 |     super(message);
  156 |     this.name = 'LinksApiError';
  157 |   }
  158 | }
  159 | 
  160 | export interface NodeClientOptions {
  161 |   /** Origin of the node, or '' for same-origin through a proxy. */
  162 |   baseUrl?: string;
  163 |   /** Session token for authenticated product calls. */
  164 |   token?: string | null;
  165 |   fetch?: typeof fetch;
  166 | }
  167 | 
  168 | export class NodeClient {
  169 |   private readonly base: string;
  170 |   private readonly fetchImpl: typeof fetch;
  171 |   token: string | null;
  172 | 
  173 |   constructor(opts: NodeClientOptions = {}) {
  174 |     this.base = `${(opts.baseUrl ?? '').replace(/\/+$/, '')}/links/v1`;
  175 |     this.token = opts.token ?? null;
  176 |     this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  177 |   }
  178 | 
  179 |   private async call<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  180 |     const headers: Record<string, string> = { accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
  181 |     if (init.body !== undefined && !(init.body instanceof Uint8Array)) headers['content-type'] = 'application/json';
  182 |     if (this.token) headers.authorization = `Bearer ${this.token}`;
  183 |     let res: Response;
  184 |     try {
  185 |       res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
  186 |     } catch {
> 187 |       throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
      |             ^ LinksApiError: the Peal Links node is not reachable
  188 |     }
  189 |     if (!res.ok) {
  190 |       const ct = res.headers.get('content-type') ?? '';
  191 |       if (!ct.includes('json') || res.status === 502 || res.status === 503 || res.status === 504) {
  192 |         throw new LinksApiError(0, 'unreachable', 'the Peal Links node is not reachable');
  193 |       }
  194 |       const body = (await res.json()) as { code?: string; detail?: string; title?: string };
  195 |       throw new LinksApiError(res.status, body.code ?? 'error', body.detail ?? body.title ?? `${res.status}`);
  196 |     }
  197 |     if (init.raw) return (await res.arrayBuffer()) as unknown as T;
  198 |     return (await res.json()) as T;
  199 |   }
  200 | 
  201 |   private post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  202 |     return this.call<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
  203 |   }
  204 | 
  205 |   // ---- status and params
  206 | 
  207 |   status(): Promise<LinksStatus> {
  208 |     return this.call('/status');
  209 |   }
  210 | 
  211 |   params(): Promise<ParamsIndex> {
  212 |     return this.call('/params');
  213 |   }
  214 | 
  215 |   /** Download one parameter file and check its digest against the index. */
  216 |   async paramFile(name: string, expectedDigest: string): Promise<Uint8Array> {
  217 |     const buf = await this.call<ArrayBuffer>(`/params/${name}`, { raw: true, headers: { accept: 'application/octet-stream' } });
  218 |     const bytes = new Uint8Array(buf);
  219 |     const digest = await sha256Hex(bytes);
  220 |     if (digest !== expectedDigest) throw new LinksApiError(0, 'digest_mismatch', `parameter file ${name} does not match its digest`);
  221 |     return bytes;
  222 |   }
  223 | 
  224 |   // ---- ledger
  225 | 
  226 |   ledger(ns: string): Promise<LedgerSummary> {
  227 |     return this.call(`/ledger/${ns}`);
  228 |   }
  229 | 
  230 |   async account(ns: string, account: string): Promise<AccountView | null> {
  231 |     try {
  232 |       return await this.call(`/ledger/${ns}/accounts/${account}`);
  233 |     } catch (e) {
  234 |       if (e instanceof LinksApiError && e.code === 'unknown_account') return null;
  235 |       throw e;
  236 |     }
  237 |   }
  238 | 
  239 |   register(ns: string, envelope: unknown): Promise<Applied> {
  240 |     return this.post(`/ledger/${ns}/register`, envelope);
  241 |   }
  242 | 
  243 |   apply(ns: string, envelope: unknown): Promise<Applied> {
  244 |     return this.post(`/ledger/${ns}/ops`, envelope);
  245 |   }
  246 | 
  247 |   /** The public operation log (registrations, mints, ops), from `from`. */
  248 |   history(ns: string, from = 1, limit = 100): Promise<{ ops: HistoryOp[] }> {
  249 |     return this.call(`/ledger/${ns}/history?from=${from}&limit=${limit}`);
  250 |   }
  251 | 
  252 |   receiptPath(ns: string, position: number, size?: number): Promise<ReceiptPath> {
  253 |     const q = size !== undefined ? `?size=${size}` : '';
  254 |     return this.call(`/ledger/${ns}/receipts/${position}/path${q}`);
  255 |   }
  256 | 
  257 |   // ---- auth
  258 | 
  259 |   nonce(): Promise<{ nonce: string; expires_at: number }> {
  260 |     return this.call('/auth/nonce');
  261 |   }
  262 | 
  263 |   async session(message: string, signature: string): Promise<SessionInfo> {
  264 |     const s = await this.post<SessionInfo>('/auth/session', { message, signature });
  265 |     this.token = s.token;
  266 |     return s;
  267 |   }
  268 | 
  269 |   me(): Promise<{ address: string; chain_id: number }> {
  270 |     return this.call('/auth/me');
  271 |   }
  272 | 
  273 |   // ---- requests
  274 | 
  275 |   createRequest(manifest: RequestManifest): Promise<PaymentRequest> {
  276 |     return this.post('/requests', manifest);
  277 |   }
  278 | 
  279 |   listRequests(): Promise<{ requests: PaymentRequest[] }> {
  280 |     return this.call('/requests');
  281 |   }
  282 | 
  283 |   /** `intentId` is the caller's payer intent: the node then reports
  284 |    * `reserved` only when someone else holds the reservation. */
  285 |   getRequest(id: string, intentId?: string): Promise<PaymentRequest> {
  286 |     const q = intentId ? `?intent=${encodeURIComponent(intentId)}` : '';
  287 |     return this.call(`/requests/${encodeURIComponent(id)}${q}`);
```
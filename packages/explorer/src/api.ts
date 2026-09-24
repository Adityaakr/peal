/** Typed fetch helpers for the coordinator REST API (/v0). */

// Same-origin by default: vite's dev/preview proxy (vite.config.ts) or the
// production Caddy edge forwards /v0 to the coordinator. Set VITE_BTE_URL at
// build time only to talk to a coordinator on another origin directly.
const BASE: string = import.meta.env.VITE_BTE_URL ?? '';

export interface CommitteeDetail {
  id: string;
  n: number;
  t: number;
  b: number;
  params_b64: string;
  params_digest: string;
  created_at: number;
  /** 'v0': simple-bte, dealt by a ceremony, fixed batch. 'v1': key from a DKG,
   * no fixed batch size. Absent on a coordinator that predates the field. */
  scheme?: 'v0' | 'v1';
  /** v1 only: the digest of the DKG output the key came from. */
  setup_digest?: string | null;
}

export interface ConditionSummary {
  id: string;
  committee_id: string;
  kind: string;
  fires_at: number | null;
  status: 'pending' | 'frozen' | 'revealed' | 'stalled';
  created_at: number;
  /** Client label set at creation (round:bid, round:vote, capsule). */
  tag?: string | null;
  ciphertext_count: number;
  real_count: number;
}

export interface Batch {
  batch_id: number;
  batch_index: number;
  frozen_at?: number;
  finalized_at?: number | null;
  predecrypt_ms: number | null;
  finalize_ms: number | null;
  /** Live share progress (present on /v0/conditions/:id). */
  verified_shares?: number;
  total_shares?: number;
  /** Packed B*48 ciphertext headers (present on /v0/reveals/:id). The other half
   * of the share check: verify_share needs the headers the share was made over. */
  headers_b64?: string;
}

export const API_BASE = BASE;

export interface ConditionDetail extends ConditionSummary {
  chain_id: number | null;
  height: number | null;
  batches: Batch[];
}

export interface RevealSlot {
  position: number;
  ct_hash: string;
  is_dummy: boolean;
  valid: boolean;
  payload_b64: string;
  /** The sealed ciphertext this slot opened. Present after reveal so the ct hash
   * can be re-derived in the browser instead of taken on the coordinator's word. */
  sealed_b64?: string;
}

export interface ShareEntry {
  batch_id: number;
  operator_id: number;
  verified: boolean;
  submitted_at_ms: number;
  /** The operator's share bytes, so the pairing check can be rerun client-side. */
  share_b64?: string;
}

export interface Reveal {
  condition_id: string;
  revealed_at: number;
  merkle_root: string;
  slots: RevealSlot[];
  shares: ShareEntry[];
  batches: Batch[];
}

/** Fetch JSON with a human error when something other than the bte
 * coordinator answers (a stray dev server on the same port returns HTML). */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    const where = BASE || window.location.origin;
    // An empty 502/503/504 is the edge answering for a coordinator it could
    // not reach (the hosted site is Caddy in front of the coordinator, and an
    // unreachable upstream comes back as a bare 502). That is a different
    // failure from an HTML page, which is a dev server holding the port, and
    // the advice for one is wrong for the other.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(
        `${where} answered ${path} with ${res.status}: the edge is up but could not reach the coordinator behind it. ` +
          `on the hosted site that means the service is running without its coordinator ` +
          `(check its Dockerfile path and deploy log); locally, start the devnet with just compose-up`,
      );
    }
    throw new Error(
      `${where} answered ${path} with ${type.split(';')[0] || 'no content type'} (status ${res.status}), not JSON. ` +
        `that is not the bte coordinator. it usually means another dev server holds the port. ` +
        `restart with: BTE_URL=http://localhost:<coordinator port> pnpm dev`,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // body was not JSON after all
    }
    throw new Error(detail || `GET ${path} failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getCommittee(): Promise<CommitteeDetail> {
  return get<CommitteeDetail>('/v0/committees/default');
}

export interface ConditionList {
  conditions: ConditionSummary[];
  /** How many exist, which is not how many were returned: the endpoint caps the
   * list. Absent on a coordinator that predates the field. */
  total: number | null;
}

export async function listConditions(): Promise<ConditionSummary[]> {
  return (await listConditionsWithTotal()).conditions;
}

export async function listConditionsWithTotal(): Promise<ConditionList> {
  const body = await get<{ conditions: ConditionSummary[]; total?: number }>('/v0/conditions');
  return {
    conditions: body.conditions,
    total: typeof body.total === 'number' ? body.total : null,
  };
}

export function getCondition(id: string): Promise<ConditionDetail> {
  return get<ConditionDetail>(`/v0/conditions/${encodeURIComponent(id)}`);
}

/** Returns null while the condition is not revealed (the API 404s). */
export async function getReveal(conditionId: string): Promise<Reveal | null> {
  const res = await fetch(`${BASE}/v0/reveals/${encodeURIComponent(conditionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /v0/reveals failed with ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error('non-JSON reveal response; wrong server on this port?');
  }
  return res.json() as Promise<Reveal>;
}

/** Resolve a short share code to the seal it names. Returns null when the
 * coordinator does not know it (unknown, or a devnet wipe). The decryption key
 * is never part of this request: it stays in the link's URL fragment. */
export async function resolveSeal(
  code: string,
): Promise<{ conditionId: string; ctHash: string } | null> {
  const res = await fetch(`${BASE}/v0/seals/${encodeURIComponent(code)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`GET /v0/seals failed with ${res.status}`);
  const body = (await res.json()) as { condition_id: string; ct_hash: string };
  return { conditionId: body.condition_id, ctHash: body.ct_hash };
}

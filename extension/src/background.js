// Network side of the extension.
//
// Content scripts inherit the host page's CSP, and X's is strict enough to
// block a direct fetch to peal.network. So every request goes through here,
// where host_permissions apply instead. Two consequences worth stating:
//
//   1. Only a lookup handle ever arrives — a share code or a condition id.
//      The parser drops a private seal's AES key before this point, so the
//      key cannot leave the page even by accident.
//   2. Responses are cached in memory. A timeline with the same seal in
//      twenty tweets costs one request, not twenty.

const API = 'https://peal.network';
const TTL_MS = 30_000;
const NEG_TTL_MS = 5 * 60_000;

/** key -> { at, value } — value null means "known missing". */
const cache = new Map();
/** key -> Promise, so concurrent asks for one seal share a single request. */
const inflight = new Map();

function fresh(entry) {
  if (!entry) return false;
  const ttl = entry.value ? TTL_MS : NEG_TTL_MS;
  return Date.now() - entry.at < ttl;
}

async function getJson(path) {
  const res = await fetch(API + path, { credentials: 'omit', cache: 'no-store' });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error('GET ' + path + ' -> ' + res.status);
  return res.json();
}

/**
 * Resolve a handle to what the card needs, or null when unknown.
 * Shape: { conditionId, status, firesAt, kind }
 */
async function resolve(handle) {
  let conditionId;
  if (handle.kind === 'code') {
    const seal = await getJson('/v0/seals/' + encodeURIComponent(handle.value));
    if (!seal) return null;
    conditionId = seal.condition_id;
  } else {
    conditionId = handle.value;
  }
  const cond = await getJson('/v0/conditions/' + encodeURIComponent(conditionId));
  if (!cond) return null;
  return {
    conditionId,
    status: cond.status,
    firesAt: cond.fires_at,
    height: cond.height,
    kind: cond.kind,
  };
}

function lookup(handle) {
  const key = handle.kind + ':' + handle.value;
  const hit = cache.get(key);
  if (fresh(hit)) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);

  const p = resolve(handle)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((e) => {
      // Leave the cache alone on a transport error so the next tick retries,
      // rather than pinning a "missing" answer for five minutes.
      console.debug('[peal] lookup failed', e);
      return undefined;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'peal:resolve') return false;
  const h = msg.handle;
  if (!h || (h.kind !== 'code' && h.kind !== 'condition') || typeof h.value !== 'string') {
    sendResponse({ ok: false });
    return false;
  }
  lookup(h).then((value) => sendResponse({ ok: true, value: value ?? null }));
  return true; // keep the channel open for the async reply
});

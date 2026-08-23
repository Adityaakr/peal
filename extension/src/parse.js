// Recognising a Peal seal link, and — just as important — refusing to carry
// the part of it that must never travel.
//
// A private seal's link ends in an AES-128-GCM key that lives only in the URL
// fragment and is never sent to any server (packages/explorer/src/privacy.ts).
// This extension only needs the countdown, which comes from the PUBLIC
// condition. So the parser deliberately returns a lookup handle and nothing
// else: the key is dropped at this boundary and never reaches the background
// worker, the network, or storage.
//
// Loaded as a plain script before content.js, so these bindings are visible to
// it through the shared isolated-world scope. MV3 content scripts do not
// support ES module imports.

const PEAL_HOST = 'peal.network';

// Short form: 11-char base64url share code, minted by the coordinator.
const PEAL_SHORT = /^#?\/?s\/([A-Za-z0-9_-]{11})(?:\/[A-Za-z0-9_-]{16,64})?$/;
// Long form, still emitted by links shared before short codes existed.
const PEAL_LONG = /^#?\/?s\/(cond_[0-9a-f]{24})\/[0-9a-f]{64}(?:\/[A-Za-z0-9_-]{16,64})?$/;

/**
 * Parse one candidate string into a lookup handle, or null.
 * Returns `{ kind: 'code' | 'condition', value }`.
 * Never returns the share key, even when the input contains one.
 */
function parseSealLink(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // X renders a display URL with no scheme, and an ellipsis where it truncated.
  // A truncated link is unusable: bail rather than guess the missing characters.
  if (s.includes('…') || s.endsWith('...')) return null;
  if (!s.includes(PEAL_HOST)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;

  let url;
  try {
    url = new URL(s);
  } catch (_) {
    return null;
  }
  if (url.hostname !== PEAL_HOST && url.hostname !== 'www.' + PEAL_HOST) return null;

  // Both the hash route (#/s/…) and a real path (/s/…) are accepted, so this
  // keeps working if public seals move to a server-visible path for OG cards.
  const tail = url.hash ? url.hash.slice(1) : url.pathname;
  const probe = tail.charAt(0) === '/' ? tail.slice(1) : tail;

  let m = probe.match(PEAL_SHORT);
  if (m) return { kind: 'code', value: m[1] };
  m = probe.match(PEAL_LONG);
  if (m) return { kind: 'condition', value: m[1] };
  return null;
}

/** A stable cache and dedupe key for a parsed handle. */
function handleKey(handle) {
  return handle.kind + ':' + handle.value;
}

// Node can require this file directly for the parser tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSealLink, handleKey };
}

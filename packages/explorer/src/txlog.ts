/** Every transaction this app sends, with a link to it.
 *
 * A page that moves someone's money and shows them nothing afterwards is
 * asking to be taken on trust, which is the opposite of what this product
 * argues for. Whatever executed should be checkable on a block explorer, by
 * the person who caused it, without asking us.
 *
 * Kept in localStorage rather than memory so the record survives a reload:
 * the moment a user most wants the hash is usually after something looked
 * like it went wrong, which is often after they refreshed.
 */
import { ACTIVE } from 'peal-auctionkit';
import type { Hex } from 'viem';

const KEY = 'peal.txlog.v1';
const LIMIT = 40;

export interface TxRecord {
  hash: Hex;
  /** What the user did, in their words rather than the contract's. */
  label: string;
  chainId: number;
  at: number;
  /** Explorer base, captured at write time so a record made on one chain
   * still links correctly after the app moves to another. */
  explorer: string;
}

const listeners = new Set<() => void>();

export function txlog(): TxRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TxRecord[]) : [];
  } catch {
    return [];
  }
}

/** Record a transaction. Ignores duplicates, since several call sites may see
 * the same hash. */
export function recordTx(hash: Hex, label: string): void {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
  const all = txlog();
  if (all.some((t) => t.hash.toLowerCase() === hash.toLowerCase())) return;
  const next = [
    { hash, label, chainId: ACTIVE.chainId, at: Math.floor(Date.now() / 1000), explorer: ACTIVE.explorer },
    ...all,
  ].slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private browsing. The links below still render for this session. */
  }
  for (const fn of listeners) fn();
}

export function recordMany(hashes: (string | undefined)[], label: string): void {
  for (const h of hashes) if (h) recordTx(h as Hex, label);
}

export function onTxLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function txUrl(t: TxRecord): string {
  return `${t.explorer}/tx/${t.hash}`;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function ago(sec: number): string {
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

/** The panel. Renders nothing when there is nothing to show, rather than an
 * empty box implying something failed. */
export function txlogHtml(): string {
  const all = txlog();
  if (!all.length) return '';
  return `<div class="ak-panel tx-panel">
    <h3>Your transactions <span class="ak-h2-note">on this device</span></h3>
    <ul class="tx-list">
      ${all
        .map(
          (t) => `<li class="tx-row">
            <span class="tx-label">${t.label.replace(/[<>&"]/g, '')}</span>
            <a class="tx-hash" href="${txUrl(t)}" target="_blank" rel="noopener">${shortHash(t.hash)}</a>
            <span class="tx-when">${ago(t.at)}</span>
          </li>`,
        )
        .join('')}
    </ul>
  </div>`;
}

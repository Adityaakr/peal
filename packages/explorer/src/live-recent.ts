// The auctions this browser has been part of.
//
// A Peal Live link is the whole auction, which is what makes it need no
// backend and also what makes it easy to lose: close the tab and the auction
// still runs, but you have nothing to open it with. This keeps a list on the
// device so a seller can find the sale they started and a bidder can get back
// to the one they bid in.
//
// It is a convenience, not a record. It lives only in this browser, it holds no
// amounts, and losing it loses nothing that matters: the auction is the batch
// on the coordinator, and the link is enough to reach it.
import { unpackTerms } from 'peal-live';

const KEY = 'peal-live:mine';
const LIMIT = 24;

export interface RecentAuction {
  /** The packed terms. The whole auction, so this list needs no lookup. */
  packed: string;
  title: string;
  closeAt: number;
  /** The short link, when one was claimed for it. */
  name?: string;
  /** Whether this browser started the auction or bid in it. Both are worth
   * keeping: a bidder wants to see what they bid in as much as a seller does. */
  role: 'host' | 'bidder';
  /** When this browser last saw it, so the list reads newest first. */
  at: number;
}

function read(): RecentAuction[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is RecentAuction => {
      if (typeof a !== 'object' || a === null) return false;
      const { packed, title, closeAt, role } = a as Partial<RecentAuction>;
      if (typeof packed !== 'string' || typeof title !== 'string') return false;
      if (typeof closeAt !== 'number' || (role !== 'host' && role !== 'bidder')) return false;
      // The stored terms have to still parse. A row that does not is a link
      // this build can no longer open, and offering it would be offering a
      // dead end: the wire format has a version for exactly this reason.
      return unpackTerms(packed) !== null;
    });
  } catch {
    return [];
  }
}

function write(list: RecentAuction[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch {
    // Private windows refuse storage, and a quota error here should never stop
    // an auction. The list is a convenience; the link is the thing that works.
  }
}

/** Note an auction. Seeing one again moves it to the top and keeps the stronger
 * role, so bidding in your own auction does not demote you to a bidder. */
export function rememberAuction(entry: Omit<RecentAuction, 'at'>): void {
  const list = read();
  const existing = list.find((a) => a.packed === entry.packed);
  const merged: RecentAuction = {
    ...entry,
    role: existing?.role === 'host' ? 'host' : entry.role,
    name: entry.name ?? existing?.name,
    at: Date.now(),
  };
  write([merged, ...list.filter((a) => a.packed !== entry.packed)]);
}

/** Newest first. */
export function recentAuctions(): RecentAuction[] {
  return read().sort((a, b) => b.at - a.at);
}

export function forgetAuctions(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage was never available.
  }
}

/** Did this browser create that auction?
 *
 * The only signal the page has for "you are the seller", and it is device local
 * by nature: an auction is a link, and nothing in it identifies who made it.
 *
 * It gates an affordance, not a permission. Everything it unlocks is a note
 * this browser keeps to itself, so somebody who edited their own storage to
 * pass this check would gain the ability to mislead nobody but themselves.
 * What it actually prevents is the opposite failure: a BIDDER being shown a
 * seller's control, pressing it, and being told their own bid is now top.
 */
export function isHostOf(packed: string): boolean {
  return read().some((a) => a.packed === packed && a.role === 'host');
}

/** The seller's private key for one auction.
 *
 * Kept beside the list of auctions this browser made, because it is the same
 * kind of thing: state that only means anything on this device. It is the only
 * copy. Nothing can read a bidder's contact details without it, which is the
 * point, and which is also why losing this browser loses them for good.
 */
function keyStore(auctionId: string): string {
  return `peal-live-key:${auctionId}`;
}

export function rememberSellerKey(auctionId: string, privateKey: JsonWebKey): void {
  try {
    localStorage.setItem(keyStore(auctionId), JSON.stringify(privateKey));
  } catch {
    // Private windows refuse storage. The auction still runs; its contact
    // details simply become unreadable, which the create page warns about.
  }
}

export function readSellerKey(auctionId: string): JsonWebKey | null {
  try {
    const raw = localStorage.getItem(keyStore(auctionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonWebKey) : null;
  } catch {
    return null;
  }
}

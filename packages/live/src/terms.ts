/** The auction's terms, and how they travel.
 *
 * Terms ride in the URL fragment rather than in any store. The link is then
 * self contained, needs no backend, and a fragment never reaches a server
 * (docker/Caddyfile:11-15), so opening an auction tells no one you did.
 *
 * The cost is that a link cannot vouch for itself. Someone can edit the terms,
 * create their own condition, anchor their own hash, and hand out a link that
 * passes every check it is able to run on itself. The only defence is comparing
 * the terms against a value obtained some other way, which is why `checksum`
 * exists and why it is built to be read out loud: on a livestream the host's
 * screen is exactly that second channel.
 */
import { isSellerKey } from './contact.js';
import { MAX_AMOUNT_MINOR } from './record.js';


/** Fixed order, so the same terms always serialise to the same bytes. This is
 * a positional tuple rather than an object because a checksum over
 * JSON.stringify would depend on key insertion order, which is a property of
 * how the object happened to be built. */
type Wire = [
  version: number,
  auctionId: string,
  title: string,
  unit: string,
  decimals: number,
  closeAt: number,
  reserveMinor: number | null,
  maxMinor: number | null,
  image: string | null,
  description: string | null,
  contactKey: string | null,
];

/** Bumped whenever the tuple gains a field: 2 for the bid ceiling, 3 for the
 * picture.
 *
 * An older link now fails to unpack rather than being read with a field
 * missing. The tuple is positional, so links of different lengths cannot be
 * told apart by shape alone, and quietly filling in a default would be
 * honouring terms nobody agreed to. */
export const TERMS_VERSION = 5;
export const MAX_TITLE_CHARS = 80;
export const MAX_UNIT_CHARS = 12;
export const MAX_AUCTION_ID_CHARS = 64;

/** Long enough for a real image host, short enough that the whole terms tuple
 * stays inside the 512 bytes the name registry accepts. */
export const MAX_IMAGE_CHARS = 200;

/** Enough for a paragraph about what is being sold. Longer than this and it
 * stops being a description and starts being a page, and it eats the budget a
 * short link has to fit inside. */
export const MAX_DESCRIPTION_CHARS = 280;

/** Why a picture address cannot be used, or null when it can.
 *
 * https only, and deliberately strict about the scheme rather than just
 * escaping it downstream. `javascript:` in an `img src` is inert in a modern
 * browser but the same string reaches other places, and `data:` would let a
 * link carry its own payload past every length check here. Refusing at the
 * edge is one rule instead of a rule per render site.
 *
 * Plain http is refused too, for a duller reason: the site is served over
 * https, so a browser blocks the image as mixed content and the seller sees a
 * blank space with no explanation. */
export function imageProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_IMAGE_CHARS) return `picture link exceeds ${MAX_IMAGE_CHARS} characters`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'that picture link is not a web address';
  }
  if (parsed.protocol !== 'https:') return 'the picture link has to start with https';
  if (!parsed.hostname) return 'that picture link has no site in it';
  return null;
}

export interface Terms {
  /** The coordinator condition. The cue that opens the batch is its close. */
  auctionId: string;
  /** What is being sold, in the host's words. */
  title: string;
  /** What bids are denominated in. A label only: nothing here moves money. */
  unit: string;
  /** How many decimal places `unit` has, so 1250 can render as 12.50. */
  decimals: number;
  /** Unix seconds. Must match the condition's fires_at, and the coordinator is
   * the one that actually acts on it. */
  closeAt: number;
  /** Below this, no bid wins. Null means any bid can. */
  reserveMinor: number | null;
  /** Above this, no bid wins either. Null means no ceiling.
   *
   * This is the cheapest defence against a bid nobody intends to honour. With
   * nothing escrowed, a bid costs nothing to make and a joke of 99,999,999
   * would otherwise take the auction. A ceiling does not stop somebody bidding
   * exactly the ceiling, but the ceiling is a number the seller already thinks
   * is plausible, so the damage is bounded by their own judgement rather than
   * by a stranger's imagination. */
  maxMinor: number | null;
  /** A picture of what is being sold. Null when there is none.
   *
   * A URL rather than the image itself, because the link IS the auction: the
   * terms ride in the fragment so the thing needs no backend, and no amount of
   * base64 fits a photograph in a URL somebody can paste into a chat.
   *
   * The consequence is worth being precise about. The address is part of the
   * terms, so it is covered by the checksum and by the record on chain, and a
   * link with a different picture has a different check code. What is NOT
   * covered is the bytes: whoever hosts that image can serve something else
   * tomorrow, and nothing here would notice. It shows what is being sold; it
   * does not attest to it. */
  image: string | null;
  /** What is being sold, in more than a title's worth of words. Null when the
   * seller did not write one.
   *
   * Part of the terms, so it is covered by the checksum and by the record on
   * chain: a link with different words has a different check code. That is the
   * point of putting it here rather than anywhere else. */
  description: string | null;
  /** The seller's public key, when they asked bidders for contact details.
   *
   * Null when they did not, and the bid form then has no contact field at all.
   * Public on purpose: every bidder needs it to encrypt to, and it being in the
   * terms means the check code covers it, so nobody can hand out a link that
   * quietly points contact details at a key of their own. */
  contactKey: string | null;
}

export class TermsError extends Error {}

function fail(why: string): never {
  throw new TermsError(why);
}

/** The exact bytes the checksum is taken over, and the bytes that go in a link. */
export function canonicalTerms(t: Terms): Uint8Array {
  if (!t.auctionId) fail('auction id is required');
  // A coordinator id is 29 characters. The bound exists because nothing else
  // constrains this field, and an unbounded id is an unbounded link.
  if (t.auctionId.length > MAX_AUCTION_ID_CHARS) fail('auction id is too long');
  const title = t.title.trim();
  if (!title) fail('the item needs a name');
  // Code points, not UTF-16 units, so the cap is the same eighty characters
  // whether they are latin, CJK or emoji.
  if ([...title].length > MAX_TITLE_CHARS) fail(`item name exceeds ${MAX_TITLE_CHARS} characters`);
  const unit = t.unit.trim();
  if (!unit || [...unit].length > MAX_UNIT_CHARS) fail('unit must be 1 to 12 characters');
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 4) {
    fail('decimals must be an integer from 0 to 4');
  }
  if (!Number.isInteger(t.closeAt) || t.closeAt <= 0) fail('close time must be unix seconds');
  if (t.reserveMinor !== null) {
    if (!Number.isInteger(t.reserveMinor) || t.reserveMinor < 0) {
      fail('reserve must be a whole number of minor units');
    }
    // The same ceiling a bid has. Number.isInteger(1e21) is true, and a reserve
    // no bid could ever meet rendered as the string "1e+21".
    if (t.reserveMinor > MAX_AMOUNT_MINOR) fail('reserve is too large');
  }
  if (t.maxMinor !== null) {
    if (!Number.isInteger(t.maxMinor) || t.maxMinor <= 0) {
      fail('maximum must be a whole number of minor units');
    }
    if (t.maxMinor > MAX_AMOUNT_MINOR) fail('maximum is too large');
    if (t.reserveMinor !== null && t.maxMinor < t.reserveMinor) {
      fail('the maximum cannot be below the reserve');
    }
  }
  if (t.image !== null) {
    const problem = imageProblem(t.image);
    if (problem) fail(problem);
  }
  if (t.contactKey !== null && !isSellerKey(t.contactKey)) {
    fail('that is not a seller key');
  }
  if (t.description !== null) {
    const description = t.description.trim();
    if ([...description].length > MAX_DESCRIPTION_CHARS) {
      fail(`the description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
    }
  }
  const wire: Wire = [
    TERMS_VERSION, t.auctionId, title, unit, t.decimals, t.closeAt, t.reserveMinor, t.maxMinor,
    t.image === null ? null : t.image.trim(),
    t.description === null || !t.description.trim() ? null : t.description.trim(),
    t.contactKey,
  ];
  return new TextEncoder().encode(JSON.stringify(wire));
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Terms as the fragment segment of a share link. */
export function packTerms(t: Terms): string {
  return b64urlEncode(canonicalTerms(t));
}

/** Read terms back out of a link. Returns null for anything that is not a
 * well formed set of terms, because the input is a URL a stranger sent. */
export function unpackTerms(packed: string): Terms | null {
  let wire: unknown;
  try {
    wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(packed)));
  } catch {
    return null;
  }
  if (!Array.isArray(wire) || wire.length !== 11) return null;
  const [version, auctionId, title, unit, decimals, closeAt, reserveMinor, maxMinor, image,
    description, contactKey] = wire as Wire;
  if (version !== TERMS_VERSION) return null;
  if (typeof auctionId !== 'string' || typeof title !== 'string' || typeof unit !== 'string') {
    return null;
  }
  if (typeof decimals !== 'number' || typeof closeAt !== 'number') return null;
  if (reserveMinor !== null && typeof reserveMinor !== 'number') return null;
  if (maxMinor !== null && typeof maxMinor !== 'number') return null;
  if (image !== null && typeof image !== 'string') return null;
  if (description !== null && typeof description !== 'string') return null;
  if (contactKey !== null && typeof contactKey !== 'string') return null;
  // Hand back what was HASHED, not what was typed into the link.
  //
  // canonicalTerms trims before hashing. Returning the untrimmed strings meant
  // two different links could produce one checksum and one terms hash while
  // rendering different titles, which is exactly the swapped link the checksum
  // exists to catch. Padding a title with newlines was enough to do it.
  const terms: Terms = {
    auctionId, title: title.trim(), unit: unit.trim(), decimals, closeAt, reserveMinor, maxMinor,
    image: image === null ? null : image.trim(),
    description: description === null || !description.trim() ? null : description.trim(),
    contactKey,
  };
  try {
    canonicalTerms(terms);
  } catch {
    return null;
  }
  // And refuse a link that is not the one packTerms would have written for
  // these terms, so the mapping from link to checksum stays one to one in both
  // directions rather than only one.
  if (packTerms(terms) !== packed.replace(/=+$/, '')) return null;
  return terms;
}

/** Crockford's alphabet: no I, L, O or U, so nothing in a checksum can be
 * misheard as something else when it is read off a screen. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A short, speakable fingerprint of the terms.
 *
 * Forty bits, which is not a cryptographic commitment and is not trying to be.
 * It exists so a viewer can hear "3QK7 M2WD" on a stream and see the same eight
 * characters under the item name in their own browser. Its threat model is a
 * swapped link, not a determined collision search.
 */
export async function checksum(t: Terms): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalTerms(t) as BufferSource));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i]!);
  let out = '';
  for (let i = 7; i >= 0; i--) out = BASE32[Number((bits >> BigInt(i * 5)) & 31n)]! + out;
  return `${out.slice(0, 4)} ${out.slice(4)}`;
}

/** The link a host shares. Terms are the only thing in it. */
export function liveLink(base: { origin: string; pathname: string }, t: Terms): string {
  return `${base.origin}${base.pathname}#/live/${packTerms(t)}`;
}

/** sha256 over the canonical terms, as 0x hex.
 *
 * This is what goes on chain. It commits to every field at once, so a link
 * whose reserve or close time was edited hashes to something else. */
export async function termsHash(t: Terms): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', canonicalTerms(t) as BufferSource);
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

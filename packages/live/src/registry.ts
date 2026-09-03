/** How an auction's terms are stored under a short name.
 *
 * `PealNames.claim` takes at most 512 bytes and the contract is immutable, so
 * that number is a fact to design around rather than a limit that can be
 * raised. An ordinary auction is close to it: a title, a paragraph, a picture
 * address and a seller key came to 549 bytes, and was refused for 37.
 *
 * Deflating first is what makes the budget comfortable rather than tight. The
 * terms are JSON containing English, which is exactly what deflate is good at:
 * the same 549 bytes become 418, and a full-length description with everything
 * else at its maximum becomes 385. Nobody has to shorten their own writing to
 * get a short link.
 *
 * A leading format byte says which shape a stored entry is, so names claimed
 * before this still resolve. It is one byte and it removes all guessing.
 */
import { canonicalTerms, unpackTerms, type Terms } from './terms.js';

/** Deflated canonical terms. */
const FORMAT_DEFLATE = 1;

/** Whether this environment can deflate. Every current browser and Node 18+
 * can; the fallback exists so an older one stores something readable rather
 * than failing to create an auction at all. */
function canCompress(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/** Push bytes through a compression stream and collect the result.
 *
 * The two stream types differ in their writable side (one takes a BufferSource,
 * the other a Uint8Array), and nothing here cares, so the parameter is the
 * shape both satisfy. */
async function through(
  stream: { writable: WritableStream<never>; readable: ReadableStream<never> },
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Both of these reject when the stream errors, which is what a registry entry
  // carrying junk does. Nothing awaits them, so an unattached rejection would
  // escape as an unhandled one and, in a browser, be reported as a crash on a
  // page that had already recovered. The readable side below carries the same
  // failure, and that one IS awaited.
  const swallow = () => {};
  void writer.write(bytes as never).catch(swallow);
  void writer.close().catch(swallow);
  return new Uint8Array(await new Response(stream.readable as never).arrayBuffer());
}

/** Terms as the registry should hold them. */
export async function toRegistryBytes(t: Terms): Promise<Uint8Array> {
  const raw = canonicalTerms(t);
  if (!canCompress()) return raw;

  const deflated = await through(new CompressionStream('deflate-raw') as never, raw);
  // Only if it actually helped. Deflate can grow very short inputs, and there
  // is no reason to pay a format byte to make something bigger.
  if (deflated.length + 1 >= raw.length) return raw;

  const out = new Uint8Array(deflated.length + 1);
  out[0] = FORMAT_DEFLATE;
  out.set(deflated, 1);
  return out;
}

/** Read back whatever shape an entry is in.
 *
 * Everything ends at `unpackTerms`, which refuses anything that is not a link
 * `packTerms` could have written, so a registry entry carrying junk resolves to
 * nothing rather than to a half-formed auction.
 */
export async function fromRegistryBytes(bytes: Uint8Array): Promise<Terms | null> {
  if (bytes.length === 0) return null;

  if (bytes[0] === FORMAT_DEFLATE && canCompress()) {
    try {
      return fromCanonical(await through(new DecompressionStream('deflate-raw') as never, bytes.subarray(1)));
    } catch {
      return null;
    }
  }

  // Claimed before compression: the canonical bytes, uncompressed.
  const plain = fromCanonical(bytes);
  if (plain) return plain;

  // Claimed before that: the base64 TEXT of the canonical bytes, which spent a
  // third of the budget on the encoding.
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return unpackTerms(text);
}

function fromCanonical(bytes: Uint8Array): Terms | null {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  try {
    return unpackTerms(btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch {
    return null;
  }
}

/** What `PealNames.claim` accepts. Mirrored from the deployed contract, which
 * cannot be changed. */
export const MAX_REGISTRY_BYTES = 512;

/**
 * Why these terms cannot have a short link, or null when they can.
 *
 * Measured through the same function that does the storing, so the answer here
 * and the answer the contract gives cannot disagree.
 *
 * The count of characters is SEARCHED rather than subtracted. Once the terms
 * are deflated, being 38 bytes over does not mean 38 characters have to go:
 * prose compresses, so it is usually far more, and telling a seller to cut 38
 * when 90 are needed sends them round the loop again. So this trims the longest
 * field until it actually fits and reports what that took.
 *
 * Only the SHORT LINK is bounded. The auction itself rides in a URL fragment,
 * which has no such limit, so a long description is perfectly fine as long as
 * nobody wants a name for it. Checking before the auction exists means a seller
 * is told to shorten something while they still can, rather than watching a
 * claim revert on an auction that is already running and can never be edited.
 */
export async function shortLinkProblem(t: Terms): Promise<string | null> {
  if ((await toRegistryBytes(t)).length <= MAX_REGISTRY_BYTES) return null;

  const description = (t.description ?? '').trim();
  const image = (t.image ?? '').trim();
  const title = t.title.trim();

  // Measured rather than assumed, so the two halves of the message cannot
  // contradict each other. The key is random and does not deflate, so this is
  // usually the cheapest fix a seller has.
  const contactAlone = t.contactKey !== null
    && (await toRegistryBytes({ ...t, contactKey: null })).length <= MAX_REGISTRY_BYTES;
  const contact = contactAlone ? ' turning off contact details would be enough on its own.' : '';

  // A picture link is an address, not prose: taking characters off the end of
  // one does not give a shorter link, it gives a broken one. So it gets the
  // only advice that works on it.
  if (image.length >= description.length && image.length >= title.length) {
    return `a short link needs less text. the picture link is the longest, at ${image.length} characters, and a picture address cannot be trimmed. use a shorter one, or shorten the description.${contact}`;
  }

  const longest = description.length >= title.length
    ? { what: 'the description', text: description, floor: 0, put: (v: string): Terms => ({ ...t, description: v || null }) }
    // A title is required, so it can be shortened but never emptied.
    : { what: 'the item name', text: title, floor: 1, put: (v: string): Terms => ({ ...t, title: v }) };

  const cut = await cutNeeded(longest);
  if (cut === null) {
    return `a short link needs less text. ${longest.what} is the longest, at ${longest.text.length} characters, but shortening it alone is not enough.${contact}`;
  }
  return `a short link needs about ${cut} fewer characters in ${longest.what}, which is ${longest.text.length} long.${contact}`;
}

/** How many characters must come off one field before the whole thing fits, or
 * null if cutting it to the bone still is not enough.
 *
 * Binary search, so a full-length description costs a handful of deflate passes
 * rather than one per character. */
async function cutNeeded(
  field: { text: string; floor: number; put: (v: string) => Terms },
): Promise<number | null> {
  const fits = async (keep: number): Promise<boolean> =>
    (await toRegistryBytes(field.put(field.text.slice(0, keep)))).length <= MAX_REGISTRY_BYTES;

  if (!(await fits(field.floor))) return null;

  // Largest prefix that still fits. Invariant: `lo` fits, `hi` does not, and
  // `hi` starts at the full text because the caller already found it too big.
  let lo = field.floor;
  let hi = field.text.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await fits(mid)) lo = mid;
    else hi = mid;
  }
  return field.text.length - lo;
}

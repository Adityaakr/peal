/** Files inside a seal.
 *
 * A sealed payload is just bytes, so a PDF or an image goes through exactly the
 * same path as text: same wasm seal, same committee, same reveal. What bytes
 * alone cannot carry is what they ARE — a filename to save as, and a type to
 * render with. This wraps them in a small header so the recipient knows.
 *
 * Wire format, inside the BTE payload:
 *
 *   "PEALF1" | u16be meta_len | meta_json | file bytes
 *
 * meta_json is `{"n": name, "t": mime, "c": caption}`, where the caption is the
 * note the sender typed alongside the file. The header costs about 60 bytes
 * plus the caption.
 *
 * A private capsule wraps this whole thing again in the AES-GCM layer from
 * privacy.ts, so the order on the wire is BTEP1( PEALF1( file ) ). Nothing
 * about the file, including its name, is readable before the cue.
 */

const MAGIC = [0x50, 0x45, 0x41, 0x4c, 0x46, 0x31]; // "PEALF1"
const META_CAP = 2048;
const CAPTION_CAP = 400;

/** What we let people attach. Kept narrow on purpose: these are the types the
 * recipient page can render or hand back safely. */
export const ACCEPTED = 'application/pdf,image/png,image/jpeg,image/gif,image/webp,image/svg+xml';

export interface SealedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  /** The note typed alongside the file. Sealed with it, so it is unreadable
   * before the cue exactly like the file is. */
  caption?: string;
}

export function isFilePayload(bytes: Uint8Array): boolean {
  return (
    bytes.length > MAGIC.length + 2 && MAGIC.every((b, i) => bytes[i] === b)
  );
}

/** Wrap a file so the recipient can name and render it. */
export function packFile(file: SealedFile): Uint8Array {
  const caption = (file.caption ?? '').slice(0, CAPTION_CAP);
  const meta = JSON.stringify(
    caption ? { n: file.name, t: file.type, c: caption } : { n: file.name, t: file.type },
  );
  const metaBytes = new TextEncoder().encode(meta);
  if (metaBytes.length > META_CAP) throw new Error('file name is too long');
  const out = new Uint8Array(MAGIC.length + 2 + metaBytes.length + file.bytes.length);
  out.set(MAGIC, 0);
  // u16 big-endian, so the header is readable without a DataView on the way out.
  out[MAGIC.length] = (metaBytes.length >> 8) & 0xff;
  out[MAGIC.length + 1] = metaBytes.length & 0xff;
  out.set(metaBytes, MAGIC.length + 2);
  out.set(file.bytes, MAGIC.length + 2 + metaBytes.length);
  return out;
}

/** Returns the file, or null when these bytes are not a packed file. */
export function unpackFile(bytes: Uint8Array): SealedFile | null {
  if (!isFilePayload(bytes)) return null;
  const metaLen = (bytes[MAGIC.length] << 8) | bytes[MAGIC.length + 1];
  const start = MAGIC.length + 2;
  // A truncated or hostile payload must fail closed, not read past the end.
  if (metaLen > META_CAP || start + metaLen > bytes.length) return null;
  let meta: { n?: unknown; t?: unknown; c?: unknown };
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.slice(start, start + metaLen)));
  } catch {
    return null;
  }
  if (typeof meta.n !== 'string' || typeof meta.t !== 'string') return null;
  return {
    name: safeName(meta.n),
    type: safeType(meta.t),
    // Rendered with textContent, so markup cannot escape; still bounded and
    // stripped of controls, since it is sender-chosen like the name.
    caption:
      typeof meta.c === 'string'
        ? meta.c.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, CAPTION_CAP)
        : undefined,
    bytes: bytes.slice(start + metaLen),
  };
}

/** The name comes from whoever sealed it, so it is never trusted as a path.
 * Strips directory separators and control characters before it can reach a
 * download attribute. */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // Strip C0 controls, DEL, and the bidi overrides, which could otherwise
  // smuggle a newline or a reversed extension into a name the browser shows.
  const clean = base.replace(/[\u0000-\u001f\u007f\u202a-\u202e]/g, '').trim();
  return clean.slice(0, 120) || 'sealed-file';
}

/** Likewise the type: an attacker-chosen MIME becomes a blob: URL, so only
 * types we intend to render are honoured and everything else downloads as
 * opaque bytes. Note SVG is deliberately NOT rendered inline — it can script. */
function safeType(raw: string): string {
  const t = raw.toLowerCase().split(';')[0].trim();
  return ACCEPTED.split(',').includes(t) ? t : 'application/octet-stream';
}

/** True when this type is safe to show inline rather than only offer to save. */
export function isInlineImage(type: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

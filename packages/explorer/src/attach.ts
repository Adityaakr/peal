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

/** Worst-case bytes this wrapping adds on top of the file itself: the PEALF1
 * header with a full-size meta block, plus the BTEP1 private layer (magic, IV,
 * and the GCM tag). A picker that checks the raw file size against the payload
 * cap has to reserve this, or a file that just fits is accepted and then
 * rejected by seal() after the whole thing has been read. */
export const ENVELOPE_OVERHEAD = MAGIC.length + 2 + META_CAP + 5 + 12 + 16;

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

/** Draw a revealed file into `host`: a preview when we can show it safely, and
 * always a way to save it. Returns a cleanup that revokes the blob URL — the
 * caller must run it, or the bytes stay pinned in memory for the tab's life. */
export function renderFile(host: HTMLElement, file: SealedFile): () => void {
  // A fresh ArrayBuffer-backed copy: the slice we were handed may be a view
  // into a larger buffer, and Blob would then capture all of it.
  const buf = new Uint8Array(new ArrayBuffer(file.bytes.length));
  buf.set(file.bytes);
  const url = URL.createObjectURL(new Blob([buf], { type: file.type }));

  host.innerHTML = '';

  // The note the sender typed sits above the file, as they wrote it.
  if (file.caption) {
    const cap = document.createElement('p');
    cap.className = 'sealed-file__caption';
    cap.textContent = file.caption;
    host.appendChild(cap);
  }

  const wrap = document.createElement('div');
  wrap.className = 'sealed-file';

  if (isInlineImage(file.type)) {
    const img = document.createElement('img');
    img.className = 'sealed-file__img';
    img.src = url;
    // The name is sender-supplied, so it goes in via textContent semantics
    // (alt is an attribute set through the DOM, never interpolated markup).
    img.alt = file.name;
    wrap.appendChild(img);
  }

  const row = document.createElement('div');
  row.className = 'sealed-file__row';

  const meta = document.createElement('div');
  meta.className = 'sealed-file__meta';
  const nameEl = document.createElement('span');
  nameEl.className = 'sealed-file__name';
  nameEl.textContent = file.name;
  const sizeEl = document.createElement('span');
  sizeEl.className = 'sealed-file__size';
  sizeEl.textContent = `${label(file.type)} · ${fmtBytes(file.bytes.length)}`;
  meta.append(nameEl, sizeEl);

  const save = document.createElement('a');
  save.className = 'btn btn-primary';
  save.href = url;
  save.download = file.name;
  save.textContent = 'save file';

  row.append(meta, save);

  // A PDF gets an open-in-tab too; the browser's viewer is better than
  // anything we would build, and the blob URL is same-origin-opaque.
  if (file.type === 'application/pdf') {
    const open = document.createElement('a');
    open.className = 'btn';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'open';
    row.appendChild(open);
  }

  wrap.appendChild(row);
  host.appendChild(wrap);

  return () => URL.revokeObjectURL(url);
}

function label(type: string): string {
  if (type === 'application/pdf') return 'PDF';
  if (type === 'application/octet-stream') return 'file';
  if (type.startsWith('image/')) return type.slice(6).toUpperCase();
  return type;
}

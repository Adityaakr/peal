// Tests for the sealed-file wire format. Run: node packages/explorer/test/attach.test.mjs
//
// The interesting cases are at the bottom: the filename and MIME type inside a
// payload are chosen by whoever sealed it, so both are treated as hostile input
// on the way out. They end up in a download attribute and a blob: URL.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globSync, readFileSync } from 'node:fs';

// Transpile the real module with esbuild rather than stripping types by hand:
// a regex approximation of TypeScript is its own source of bugs, and this test
// exists to check the module, not my stripping.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const esbuild = globSync('node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild', {
  cwd: repo,
})[0];
if (!esbuild) throw new Error('esbuild not found; run pnpm install');
const js = execFileSync(join(repo, esbuild), ['--loader=ts', '--format=esm'], {
  input: readFileSync(join(here, '../src/attach.ts')),
}).toString();
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const { packFile, unpackFile, isFilePayload, isInlineImage, fmtBytes } = mod;

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 1, 2, 3]);

console.log('\nround trip');
t('a pdf survives pack -> unpack byte for byte', () => {
  const packed = packFile({ name: 'roadmap.pdf', type: 'application/pdf', bytes: pdf });
  const out = unpackFile(packed);
  assert.strictEqual(out.name, 'roadmap.pdf');
  assert.strictEqual(out.type, 'application/pdf');
  assert.deepStrictEqual([...out.bytes], [...pdf]);
});
t('an empty file round trips', () => {
  const packed = packFile({ name: 'empty.png', type: 'image/png', bytes: new Uint8Array(0) });
  const out = unpackFile(packed);
  assert.strictEqual(out.bytes.length, 0);
  assert.strictEqual(out.type, 'image/png');
});
t('a 1 MiB file round trips', () => {
  const big = new Uint8Array(1024 * 1024).map((_, i) => i & 0xff);
  const out = unpackFile(packFile({ name: 'big.pdf', type: 'application/pdf', bytes: big }));
  assert.strictEqual(out.bytes.length, big.length);
  assert.strictEqual(out.bytes[1000], big[1000]);
});
t('unicode filename survives', () => {
  const out = unpackFile(packFile({ name: 'plán-2027-📄.pdf', type: 'application/pdf', bytes: pdf }));
  assert.strictEqual(out.name, 'plán-2027-📄.pdf');
});
t('header overhead stays small', () => {
  const packed = packFile({ name: 'roadmap.pdf', type: 'application/pdf', bytes: pdf });
  const overhead = packed.length - pdf.length;
  assert.ok(overhead < 80, 'overhead was ' + overhead);
});

console.log('\ndetection');
t('text is not mistaken for a file', () => {
  const text = new TextEncoder().encode('just a sealed sentence');
  assert.strictEqual(isFilePayload(text), false);
  assert.strictEqual(unpackFile(text), null);
});
t('empty and tiny inputs are not files', () => {
  assert.strictEqual(isFilePayload(new Uint8Array(0)), false);
  assert.strictEqual(isFilePayload(new Uint8Array([0x50, 0x45])), false);
});
t('a BTEP1 private payload is not a file payload', () => {
  const btep1 = new TextEncoder().encode('BTEP1' + 'x'.repeat(40));
  assert.strictEqual(isFilePayload(btep1), false);
});

console.log('\nmalformed input fails closed');
t('truncated body does not read past the end', () => {
  const packed = packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf });
  assert.strictEqual(unpackFile(packed.slice(0, 8)), null);
});
t('a meta length that overruns the buffer is refused', () => {
  const packed = packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf });
  packed[6] = 0xff;
  packed[7] = 0xff;
  assert.strictEqual(unpackFile(packed), null);
});
t('non-JSON metadata is refused', () => {
  const bad = new Uint8Array([0x50, 0x45, 0x41, 0x4c, 0x46, 0x31, 0, 4, 110, 111, 112, 101, 9, 9]);
  assert.strictEqual(unpackFile(bad), null);
});
t('metadata missing its fields is refused', () => {
  const meta = new TextEncoder().encode('{"x":1}');
  const b = new Uint8Array(8 + meta.length);
  b.set([0x50, 0x45, 0x41, 0x4c, 0x46, 0x31, 0, meta.length]);
  b.set(meta, 8);
  assert.strictEqual(unpackFile(b), null);
});

console.log('\nHOSTILE METADATA: the sender picks the name and type');
function nameFor(raw) {
  const packed = packFile({ name: 'x', type: 'application/pdf', bytes: pdf });
  const meta = new TextEncoder().encode(JSON.stringify({ n: raw, t: 'application/pdf' }));
  const b = new Uint8Array(8 + meta.length + pdf.length);
  b.set([0x50, 0x45, 0x41, 0x4c, 0x46, 0x31, (meta.length >> 8) & 0xff, meta.length & 0xff]);
  b.set(meta, 8);
  b.set(pdf, 8 + meta.length);
  void packed;
  return unpackFile(b).name;
}
t('path traversal is stripped to a bare name', () => {
  assert.strictEqual(nameFor('../../../etc/passwd'), 'passwd');
  assert.strictEqual(nameFor('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.strictEqual(nameFor('/etc/shadow'), 'shadow');
});
t('control characters and newlines are stripped', () => {
  assert.strictEqual(nameFor('inv\u0000oice\n.pdf'), 'invoice.pdf');
  assert.strictEqual(nameFor('a\u007fb.pdf'), 'ab.pdf');
});
t('bidi override cannot fake an extension', () => {
  const n = nameFor('report\u202Efdp.exe');
  assert.ok(!n.includes('\u202E'), 'bidi override survived: ' + JSON.stringify(n));
});
t('a name that strips to nothing gets a fallback', () => {
  assert.strictEqual(nameFor('\u0000\u0000'), 'sealed-file');
  assert.strictEqual(nameFor('/'), 'sealed-file');
});
t('an absurdly long name is truncated', () => {
  assert.ok(nameFor('a'.repeat(500) + '.pdf').length <= 120);
});

function typeFor(raw) {
  const meta = new TextEncoder().encode(JSON.stringify({ n: 'f', t: raw }));
  const b = new Uint8Array(8 + meta.length + pdf.length);
  b.set([0x50, 0x45, 0x41, 0x4c, 0x46, 0x31, (meta.length >> 8) & 0xff, meta.length & 0xff]);
  b.set(meta, 8);
  b.set(pdf, 8 + meta.length);
  return unpackFile(b).type;
}
t('an unlisted MIME type becomes opaque bytes', () => {
  assert.strictEqual(typeFor('text/html'), 'application/octet-stream');
  assert.strictEqual(typeFor('application/javascript'), 'application/octet-stream');
  assert.strictEqual(typeFor(''), 'application/octet-stream');
});
t('parameters and case are normalised before the check', () => {
  assert.strictEqual(typeFor('APPLICATION/PDF'), 'application/pdf');
  assert.strictEqual(typeFor('application/pdf; charset=binary'), 'application/pdf');
});
t('svg is accepted as a type but never rendered inline', () => {
  assert.strictEqual(typeFor('image/svg+xml'), 'image/svg+xml');
  assert.strictEqual(isInlineImage('image/svg+xml'), false, 'svg can script; must not inline');
  assert.strictEqual(isInlineImage('text/html'), false);
  assert.strictEqual(isInlineImage('image/png'), true);
});

console.log('\ncaption travels with the file');
t('a caption round trips alongside the bytes', () => {
  const out = unpackFile(
    packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: 'hey' }),
  );
  assert.strictEqual(out.caption, 'hey');
  assert.deepStrictEqual([...out.bytes], [...pdf]);
});
t('no caption stays undefined and costs nothing', () => {
  const withCap = packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: 'x' });
  const without = packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf });
  assert.strictEqual(unpackFile(without).caption, undefined);
  assert.ok(without.length < withCap.length, 'absent caption should not be serialised');
});
t('an empty caption is treated as none', () => {
  assert.strictEqual(unpackFile(packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: '' })).caption, undefined);
});
t('a multi-line caption keeps its newlines', () => {
  const out = unpackFile(packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: 'line one\nline two' }));
  assert.strictEqual(out.caption, 'line one\nline two');
});
t('an over-long caption is capped', () => {
  const out = unpackFile(packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: 'z'.repeat(5000) }));
  assert.ok(out.caption.length <= 400, 'caption was ' + out.caption.length);
});
t('markup in a caption is data, not markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const out = unpackFile(packFile({ name: 'a.pdf', type: 'application/pdf', bytes: pdf, caption: evil }));
  // renderFile sets it via textContent; the value must survive verbatim so the
  // DOM escapes it rather than the format silently mangling it.
  assert.strictEqual(out.caption, evil);
});

console.log('\nformatting');
t('byte sizes read sensibly', () => {
  assert.strictEqual(fmtBytes(512), '512 B');
  assert.strictEqual(fmtBytes(2048), '2 KB');
  assert.strictEqual(fmtBytes(1024 * 1024 * 2.5), '2.5 MB');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', 0 failed'}\n`);

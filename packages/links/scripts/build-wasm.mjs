// Build the wallet wasm (crates/peal-links-wasm) with wasm-pack, target web,
// single-threaded, and inline it as base64 next to the generated glue, the
// way packages/sdk does. Consumers need no bundler config.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(pkgDir, '..', '..');
const crate = join(repoRoot, 'crates', 'peal-links-wasm');
const outDir = join(crate, 'pkg');

if (!process.env.PEAL_LINKS_SKIP_WASM_PACK || !existsSync(outDir)) {
  execSync('wasm-pack build crates/peal-links-wasm --target web --release --out-dir pkg', {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
const gen = join(pkgDir, 'src', 'generated');
rmSync(gen, { recursive: true, force: true });
mkdirSync(gen, { recursive: true });
cpSync(join(outDir, 'peal_links_wasm.js'), join(gen, 'peal_links_wasm.js'));
cpSync(join(outDir, 'peal_links_wasm.d.ts'), join(gen, 'peal_links_wasm.d.ts'));
const wasm = readFileSync(join(outDir, 'peal_links_wasm_bg.wasm'));
writeFileSync(join(gen, 'wasm-b64.js'), `export default ${JSON.stringify(wasm.toString('base64'))};\n`);
writeFileSync(join(gen, 'wasm-b64.d.ts'), 'declare const b64: string;\nexport default b64;\n');
console.log(`peal-links wasm inlined (${(wasm.length / 1024 / 1024).toFixed(1)} MB)`);

// Bundles embed/peal.ts into public/peal.js: one self-contained ES module with
// the wasm inlined, served from the site root so integrating needs no install.
import { build } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: { entry: join(root, 'embed', 'peal.ts'), formats: ['es'], fileName: () => 'peal.js' },
    outDir: join(root, 'public'),
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
  },
});
console.log('peal.js built');

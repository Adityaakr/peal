// Write the developer pages as static HTML into dist/, one file per page.
//
// A reader that runs no JavaScript, which is most agent fetchers and every
// crawler, used to get the shell for /developers: a header, an empty <main>,
// and a script tag. The copy lived only inside the Vite bundle. This step loads
// src/prerender.ts through Vite's own SSR loader (so import.meta.env and the
// workspace imports resolve exactly as they do in the bundle), renders each
// page with the same shell function the browser uses, and writes
// dist/<path>/index.html. The static file server picks these up directly; the
// coordinator, which serves the shell for these paths in production, prefers
// them when present (crates/bte-coordinator/src/names.rs).
//
// Runs after `vite build`, because it needs dist/index.html for the hashed
// asset tags.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const explorer = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(explorer, 'dist');
const shellPath = join(dist, 'index.html');

if (!existsSync(shellPath)) {
  console.error('prerender: dist/index.html is missing. Run `vite build` first.');
  process.exit(1);
}
const shell = readFileSync(shellPath, 'utf8');
if (!shell.includes('<main id="app"></main>')) {
  console.error('prerender: the shell has no empty <main id="app">; refusing to guess where the article goes.');
  process.exit(1);
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const replaceMeta = (html, key, content) =>
  html.replace(new RegExp(`((?:property|name)="${key}" content=")[^"]*(")`), `$1${esc(content)}$2`);

const server = await createServer({
  configFile: join(explorer, 'vite.config.ts'),
  root: explorer,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
});

try {
  const { prerenderDocs } = await server.ssrLoadModule('/src/prerender.ts');
  let n = 0;
  for (const page of prerenderDocs()) {
    let html = shell.replace(/<title>[^<]*<\/title>/, `<title>${esc(page.title)} · Peal for developers</title>`);
    html = replaceMeta(html, 'description', page.lede);
    html = replaceMeta(html, 'og:title', page.title);
    html = replaceMeta(html, 'og:description', page.lede);
    // renderDocs adds this class at runtime to unclamp <main>; the static page
    // needs it from the first paint or the layout jumps when the app boots.
    html = html.replace('<body>', '<body class="docs-page">');
    // The shell's sidebar and pager link by fragment, which the app's router
    // understands and a reader with no JavaScript cannot follow. The static
    // copy links by clean path instead; the router accepts those too, so the
    // same anchor works for both kinds of reader.
    const article = page.html.replace(/href="#\/developers(\/[a-z0-9-]+)?"/g, (_m, sub) => `href="/developers${sub ?? ''}"`);
    html = html.replace('<main id="app"></main>', `<main id="app">${article}</main>`);
    const out = join(dist, page.path, 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    n += 1;
  }
  console.log(`prerender: wrote ${n} developer pages into dist/`);
} finally {
  await server.close();
}

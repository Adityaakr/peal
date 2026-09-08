/** The developer pages as static HTML, for readers that run no JavaScript.
 *
 * Most agents fetch a URL and read what comes back; so does every crawler. What
 * came back from /developers was the shell: a header, an empty <main>, and a
 * script tag. `scripts/prerender-docs.mjs` loads this module through Vite's SSR
 * loader after the build and writes one HTML file per page into dist/, with
 * the article already in <main>. The app then boots over it and re-renders the
 * same shell, because both paths call `docsShellHtml`.
 *
 * This module runs under Node, so nothing here may touch `window` or
 * `document`. Pages that need the site origin for their examples are given the
 * production one.
 */
import { docsShellHtml, renderMarkdown, tocLinksHtml, withHeadingIds, type DocsPage } from './docs';
import { intro } from './pages/docs/intro';
import { quickstart } from './pages/docs/quickstart';
import { agents } from './pages/docs/agents';
import { howItWorks } from './pages/docs/howitworks';
import { auctions } from './pages/docs/auctions';
import { useCases } from './pages/docs/usecases';
import { apiReference } from './pages/docs/api';
import { limits } from './pages/docs/limits';
import { network } from './pages/docs/network';
import { x402Page } from './pages/docs/x402';
import { roadmap } from './pages/docs/roadmap';
import { createAuctionDocsPage } from './pages/docs-create-auction';

export interface PrerenderedDoc {
  /** The clean path, without a leading slash: `developers/quickstart`. */
  path: string;
  title: string;
  lede: string;
  /** What goes inside <main id="app">. */
  html: string;
}

/** Kept in step with the router in main.ts and the page table in
 * crates/bte-coordinator/src/pages.rs. */
const PAGES: [string, DocsPage][] = [
  ['developers', intro],
  ['developers/quickstart', quickstart],
  ['developers/agents', agents],
  ['developers/howitworks', howItWorks],
  ['developers/auctions', auctions],
  ['developers/createauction', createAuctionDocsPage('https://peal.network')],
  ['developers/usecases', useCases],
  ['developers/api', apiReference],
  ['developers/x402', x402Page],
  ['developers/limits', limits],
  ['developers/network', network],
  ['developers/roadmap', roadmap],
];

export function prerenderDocs(): PrerenderedDoc[] {
  return PAGES.map(([path, page]) => {
    const body = withHeadingIds(page.html ?? renderMarkdown(page.markdown ?? ''));
    return {
      path,
      title: page.title,
      lede: page.lede,
      html: docsShellHtml(page, `#/${path}`, page.wide ? '' : tocLinksHtml(body)),
    };
  });
}

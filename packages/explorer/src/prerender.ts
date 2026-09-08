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
import { protocolHtml } from './pages/protocol';
import { sealbidLandingHtml } from './pages/sealbid-landing';
import { mempoolLandingHtml } from './pages/mempool-landing';
import { stakeholderTokensHtml } from './pages/stakeholder-tokens';
import { philosophyHtml } from './pages/philosophy';

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

/** The four pages the developer docs point at for the committee, the ceremony
 * and the threat model. Vanilla renderers, so each exposes its markup as a
 * string and the page is written out the same way the docs are. The widgets
 * on them (the hero loops, the section nav, copy buttons) are wired by the
 * renderer at mount and fall back to their static content here. */
const PAGES_STATIC: [string, string, () => string][] = [
  ['protocol', 'Peal protocol. how guaranteed reveal works', protocolHtml],
  ['auction', 'SealBid. sealed-bid auctions on Peal', sealbidLandingHtml],
  ['mempool', 'Peal Network. the mempool goes dark', mempoolLandingHtml],
  ['stakeholder-tokens', 'Stakeholder tokens. Startup fundraising powered by Peal', stakeholderTokensHtml],
  ['philosophy', 'The Peal philosophy. Programmable disclosure', philosophyHtml],
];

export function prerenderPages(): PrerenderedDoc[] {
  return PAGES_STATIC.map(([path, title, html]) => ({ path, title, lede: '', html: html() }));
}

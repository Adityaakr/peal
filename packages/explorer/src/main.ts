import './style.css';
import { packTerms } from 'peal-live';
import { mountAuth } from './auth';
import { resolveName } from './live-chain';
import { mountNav } from './nav';
import { resolveSeal } from './api';
import { renderHome } from './pages/home';
import { renderAuction, renderAuctionAt } from './pages/auction';
import { renderSealbidLanding } from './pages/sealbid-landing';
import { renderAuctionsList } from './pages/auctions-list';
import { renderAuctionCreate } from './pages/auction-create';
import { renderCondition } from './pages/condition';
import { renderExecution } from './pages/execution';
import { renderLanding } from './pages/landing';
import { renderLive } from './pages/live';
import { renderMempool } from './pages/mempool';
import { renderMempoolLanding } from './pages/mempool-landing';
import { renderPhilosophy } from './pages/philosophy';
import { renderProtocol } from './pages/protocol';
import { renderCreateAuctionDocs } from './pages/docs-create-auction';
import { renderDocs } from './docs';
import { intro } from './pages/docs/intro';
import { quickstart } from './pages/docs/quickstart';
import { agents } from './pages/docs/agents';
import { howItWorks } from './pages/docs/howitworks';
import { auctions as auctionDocs } from './pages/docs/auctions';
import { useCases } from './pages/docs/usecases';
import { apiReference } from './pages/docs/api';
import { limits as limitsDocs } from './pages/docs/limits';
import { network as networkDocs } from './pages/docs/network';
import { x402Page } from './pages/docs/x402';
import { installRegionHeader } from './region';
import { roadmap } from './pages/docs/roadmap';
import { renderSealView } from './pages/seal-view';

type Cleanup = () => void;

let cleanup: Cleanup | null = null;

/** Short share links resolve the code to (conditionId, ctHash) once, then hand
 * off to the normal seal view. The resolve is deliberately NOT in the seal
 * view's 2s poll loop: one lookup per open, not a per-recipient heartbeat.
 * The decryption key never enters the request — it stays in the fragment. */
function renderShortSeal(root: HTMLElement, code: string, shareKey?: string): Cleanup {
  let inner: Cleanup | null = null;
  let stale = false;
  root.innerHTML = `
    <section class="seal-view">
      <p class="seal-kicker">someone sealed this for you</p>
      <div class="card seal-card">
        <div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div>
      </div>
    </section>`;
  void resolveSeal(code)
    .then((found) => {
      if (stale) return;
      if (!found) {
        root.innerHTML = `
          <section class="seal-view">
            <p class="seal-kicker">this seal could not be found</p>
            <div class="card seal-card">
              <p class="muted">the coordinator does not know this link. it may be for a
              different network, or the devnet was wiped.</p>
            </div>
          </section>`;
        return;
      }
      inner = renderSealView(root, found.conditionId, found.ctHash, shareKey);
    })
    .catch(() => {
      if (stale) return;
      root.innerHTML = `
        <section class="seal-view">
          <p class="seal-kicker">could not reach the network</p>
          <div class="card seal-card">
            <p class="muted">the coordinator is unreachable. the seal is fine; try again.</p>
          </div>
        </section>`;
    });
  return () => {
    stale = true;
    if (inner) inner();
  };
}

/** A short link: `peal.network/shoonya` rather than a hundred and sixty
 * characters of base64.
 *
 * The edge already serves the app for any path (docker/Caddyfile:14), so this
 * needs no server change and no redirect. What the path does NOT carry is the
 * auction, so unlike every other route this one cannot render from the URL
 * alone: it asks the registry contract, which is a network round trip and is
 * why there is a loading state here and nowhere else.
 */
function renderNamedAuction(root: HTMLElement, name: string): Cleanup {
  let inner: Cleanup | null = null;
  let stale = false;
  root.innerHTML = `
    <section class="live-page">
      <p class="live-kicker">peal live</p>
      <div class="card live-card">
        <div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div>
      </div>
    </section>`;

  void resolveName(name)
    .then((terms) => {
      if (stale) return;
      if (!terms) {
        root.innerHTML = `
          <section class="live-page">
            <p class="live-kicker">peal live</p>
            <h1 class="live-title">${name}</h1>
            <div class="card live-card">
              <p class="muted">no auction has claimed this link. check the spelling, or the person
              who shared it may not have finished creating it.</p>
              <a class="btn" href="#/create">start your own auction</a>
            </div>
          </section>`;
        return;
      }
      inner = renderLive(root, packTerms(terms));
    })
    .catch(() => {
      if (stale) return;
      root.innerHTML = `
        <section class="live-page">
          <p class="live-kicker">peal live</p>
          <div class="card live-card">
            <p class="muted">could not reach the chain to look this link up. the auction is fine;
            try again.</p>
          </div>
        </section>`;
    });

  return () => {
    stale = true;
    if (inner) inner();
  };
}

// Pages live at real paths as well as fragments, because a fragment is never
// sent to a server and search engines do not index them: the whole site had one
// indexable URL. The server hands /developers the developers page's meta; this
// is the half that makes the app render it. Kept in step with
// crates/bte-coordinator/src/pages.rs, which owns the same list.
const PAGE_PATHS = new Set([
  'developers', 'developers/quickstart', 'developers/agents', 'developers/howitworks',
  'developers/auctions', 'developers/createauction', 'developers/usecases',
  'developers/api', 'developers/x402', 'developers/limits', 'developers/network',
  'developers/roadmap',
  'protocol', 'mempool', 'auction', 'auctions', 'execution', 'philosophy', 'create', 'app',
]);

/** Whether a fragment names a developer page, so it can be upgraded to a path. */
function hashIsDocs(hash: string): boolean {
  return hash.startsWith('#/developers') && PAGE_PATHS.has(hash.slice(2));
}

/** Whether a path is one of the developer pages served at a clean URL. */
function isDocsPath(path: string): boolean {
  return path === 'developers' || path.startsWith('developers/');
}

function route(): void {
  if (cleanup) cleanup();
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  // Pages live at real paths as well as fragments, because a fragment is never
  // sent to a server and search engines do not index them: the whole site had
  // one indexable URL. The server hands /developers the developers page's meta;
  // this is the half that makes the app render it. Kept in step with
  // crates/bte-coordinator/src/pages.rs, which owns the same list.
  const pagePath = location.pathname.replace(/^\/|\/$/g, '');
  // The developer section is addressed by path alone: peal.network/developers,
  // no fragment. It is the URL people paste into a channel and the one the
  // sitemap advertises, and a `#` in the middle of it makes a documentation
  // link read like an anchor into somewhere else.
  //
  // Everywhere else keeps the older behaviour of path plus fragment. The
  // fragment is still what this router branches on, so nothing below had to
  // learn about paths: a clean developer path is translated into the fragment
  // it means, and the address bar is left alone.
  const hashIsEmpty = !location.hash || location.hash === '#' || location.hash === '#/';
  const cleanPath = isDocsPath(pagePath) ? pagePath : null;

  // What to render, decided BEFORE the address bar is touched.
  //
  // This used to be computed after the normalisation below, and the two
  // branches that strip a fragment left location.hash empty, so the router read
  // "#/" and rendered the landing page under a correct looking docs URL. Every
  // older `#/developers/...` link broke that way, silently: right address, wrong
  // page. Read the intent first, then rewrite the bar.
  const hash = !hashIsEmpty
    ? location.hash
    : cleanPath
      ? `#/${cleanPath}`
      : '#/';

  if (cleanPath) {
    if (!hashIsEmpty && location.hash !== `#/${cleanPath}`) {
      // A link out of the docs, followed while a docs path was in the bar. The
      // fragment is the truth, so the stale path goes.
      history.replaceState(null, '', `/${location.hash}`);
    } else if (!hashIsEmpty) {
      // An older `/developers#/developers` link. The fragment says nothing the
      // path does not, so it goes rather than sitting there looking like an
      // anchor into somewhere else.
      history.replaceState(null, '', `/${cleanPath}`);
    }
  } else if (PAGE_PATHS.has(pagePath)) {
    if (hashIsEmpty) {
      // replace, not assign: the address bar keeps the path a crawler indexed
      // and a person can copy, while the app routes on the fragment it knows.
      history.replaceState(null, '', `/${pagePath}#/${pagePath}`);
    } else if (location.hash !== `#/${pagePath}`) {
      history.replaceState(null, '', `/${location.hash}`);
    }
  } else if (hashIsDocs(location.hash)) {
    // Somebody followed an old `peal.network/#/developers/api` link. Upgrade it
    // in place, so what they copy out of the bar afterwards is the clean one.
    history.replaceState(null, '', `/${location.hash.slice(2)}`);
  }

  // A bare path is only a short link when there is no hash asking for something
  // else. Following a nav link from `/shoonya` should go to that page, not stay
  // stuck on the auction, so a hash always wins and the path is then normalised
  // away rather than trailing along in the address bar.
  // Page paths are never auction names, or the normalisation below would strip
  // /developers off the address bar the instant it loaded, throwing away the
  // URL a crawler indexed and a person copied.
  const shortLink = location.pathname.match(/^\/([a-z0-9-]{3,32})\/?$/);
  const named = shortLink && !PAGE_PATHS.has(shortLink[1]!) ? shortLink : null;
  const hashIsBare = hashIsEmpty;
  if (named && !hashIsBare) {
    history.replaceState(null, '', `/${location.hash}`);
  } else if (named && hashIsBare) {
    document.body.classList.remove('landing-page');
    document.body.classList.add('no-tagline');
    cleanup = renderNamedAuction(root, named[1]!);
    return;
  }
  // The landing owns the root and brings its own chrome; body.landing-page
  // hides the standard site header and unclamps <main> (see style.css).
  const isLanding = hash === '#/' || hash === '#';
  document.body.classList.toggle('landing-page', isLanding);
  // The tagline introduces the network, so it belongs on the pages that are
  // introducing it. Everywhere else the page already has its own title and a
  // standing subtitle is a second heading competing with it.
  document.body.classList.toggle('no-tagline', !(isLanding || hash === '#/app'));
  // Long form, kept forever: every link ever shared carries the condition id
  // and the full ct_hash, so it renders with no coordinator round trip.
  const seal = hash.match(/^#\/s\/([^/]+)\/([0-9a-f]{64})(?:\/([A-Za-z0-9_-]{16,64}))?$/);
  // Short form: an 11-char server-issued share code, resolved before render.
  // Disjoint from the long form, which always has a mandatory 64-hex segment.
  const shortSeal = hash.match(/^#\/s\/([A-Za-z0-9_-]{11})(?:\/([A-Za-z0-9_-]{16,64}))?$/);
  const match = hash.match(/^#\/condition\/(.+)$/);
  const auctionAt = hash.match(/^#\/a\/(0x[0-9a-fA-F]{40})$/);
  // Peal Live carries the whole auction in the fragment, so the link is self
  // contained: no lookup, no storage, and no server ever learns which auction
  // was opened. base64url only, which is all packTerms can emit.
  const live = hash.match(/^#\/live\/([A-Za-z0-9_-]+)$/);
  if (seal) {
    cleanup = renderSealView(root, decodeURIComponent(seal[1]), seal[2], seal[3]);
  } else if (shortSeal) {
    cleanup = renderShortSeal(root, shortSeal[1], shortSeal[2]);
  } else if (match) {
    cleanup = renderCondition(root, decodeURIComponent(match[1]));
  } else if (hash === '#/auction') {
    // Mirrors the mempool split: #/auction is the landing, the product page
    // lives at its own route. See main.ts's #/mempool vs #/encrypted-mempool.
    cleanup = renderSealbidLanding(root);
  } else if (hash === '#/auctions') {
    cleanup = renderAuctionsList(root);
  } else if (hash === '#/create') {
    cleanup = renderAuctionCreate(root);
  } else if (hash === '#/live') {
    // One creation surface. #/live is kept because it was shared, and it lands
    // on the same page with the live kind already chosen.
    cleanup = renderAuctionCreate(root, 'live');
  } else if (live) {
    cleanup = renderLive(root, live[1]!);
  } else if (auctionAt) {
    // The shareable link. Any auction address renders the product page, so a
    // link handed to a stranger works without them knowing anything about us.
    cleanup = renderAuctionAt(root, auctionAt[1] as `0x${string}`);
  } else if (hash === '#/sealed-bid-auction') {
    cleanup = renderAuction(root);
  } else if (hash === '#/execution') {
    cleanup = renderExecution(root);
  } else if (hash === '#/mempool') {
    cleanup = renderMempoolLanding(root);
  } else if (hash === '#/encrypted-mempool') {
    cleanup = renderMempool(root);
  } else if (hash === '#/protocol') {
    cleanup = renderProtocol(root);
  } else if (hash === '#/developers') {
    cleanup = renderDocs(root, intro, '#/developers');
  } else if (hash === '#/developers/quickstart') {
    cleanup = renderDocs(root, quickstart, hash);
  } else if (hash === '#/developers/agents') {
    cleanup = renderDocs(root, agents, hash);
  } else if (hash === '#/developers/howitworks') {
    cleanup = renderDocs(root, howItWorks, hash);
  } else if (hash === '#/developers/auctions') {
    cleanup = renderDocs(root, auctionDocs, hash);
  } else if (hash === '#/developers/usecases') {
    cleanup = renderDocs(root, useCases, hash);
  } else if (hash === '#/developers/api') {
    cleanup = renderDocs(root, apiReference, hash);
  } else if (hash === '#/developers/limits') {
    cleanup = renderDocs(root, limitsDocs, hash);
  } else if (hash === '#/developers/x402') {
    cleanup = renderDocs(root, x402Page, hash);
  } else if (hash === '#/developers/network') {
    cleanup = renderDocs(root, networkDocs, hash);
  } else if (hash === '#/developers/roadmap') {
    cleanup = renderDocs(root, roadmap, hash);
  } else if (hash === '#/developers/createauction') {
    cleanup = renderCreateAuctionDocs(root);
  } else if (hash === '#/philosophy') {
    cleanup = renderPhilosophy(root);
  } else if (isLanding) {
    cleanup = renderLanding(root);
  } else {
    cleanup = renderHome(root);
  }
}

// Before anything makes a request, so the first call of the session carries it
// too. See region.ts: a coarse, self reported timezone on our own API paths and
// nowhere else.
installRegionHeader();

// One React root for Privy, mounted outside the router element so navigation
// never unmounts the session.
mountAuth();
mountNav();

window.addEventListener('hashchange', route);
// Back and forward across pushed docs paths, which change no fragment and so
// fire no hashchange.
window.addEventListener('popstate', route);

// Links into the developer section navigate by path. Written once here rather
// than in every docs page, so a new cross reference is an ordinary `#/...`
// anchor and still lands on a clean URL.
document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
    return;
  }
  const anchor = (ev.target as HTMLElement | null)?.closest?.('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || !href || !hashIsDocs(href)) return;
  // Anything asking to open elsewhere is left to the browser.
  if (anchor.target && anchor.target !== '_self') return;
  ev.preventDefault();
  const path = `/${href.slice(2)}`;
  if (location.pathname !== path || location.hash) {
    history.pushState(null, '', path);
  }
  route();
  window.scrollTo({ top: 0 });
});

route();

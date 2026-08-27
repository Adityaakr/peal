import './style.css';
import { mountAuth } from './auth';
import { resolveSeal } from './api';
import { renderHome } from './pages/home';
import { renderAuction, renderAuctionAt } from './pages/auction';
import { renderSealbidLanding } from './pages/sealbid-landing';
import { renderAuctionsList } from './pages/auctions-list';
import { renderAuctionCreate } from './pages/auction-create';
import { renderCondition } from './pages/condition';
import { renderExecution } from './pages/execution';
import { renderLanding } from './pages/landing';
import { renderMempool } from './pages/mempool';
import { renderMempoolLanding } from './pages/mempool-landing';
import { renderPhilosophy } from './pages/philosophy';
import { renderProtocol } from './pages/protocol';
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

function route(): void {
  if (cleanup) cleanup();
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  const hash = location.hash || '#/';
  // The landing owns the root and brings its own chrome; body.landing-page
  // hides the standard site header and unclamps <main> (see style.css).
  const isLanding = hash === '#/' || hash === '#';
  document.body.classList.toggle('landing-page', isLanding);
  // Long form, kept forever: every link ever shared carries the condition id
  // and the full ct_hash, so it renders with no coordinator round trip.
  const seal = hash.match(/^#\/s\/([^/]+)\/([0-9a-f]{64})(?:\/([A-Za-z0-9_-]{16,64}))?$/);
  // Short form: an 11-char server-issued share code, resolved before render.
  // Disjoint from the long form, which always has a mandatory 64-hex segment.
  const shortSeal = hash.match(/^#\/s\/([A-Za-z0-9_-]{11})(?:\/([A-Za-z0-9_-]{16,64}))?$/);
  const match = hash.match(/^#\/condition\/(.+)$/);
  const auctionAt = hash.match(/^#\/a\/(0x[0-9a-fA-F]{40})$/);
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
  } else if (hash === '#/philosophy') {
    cleanup = renderPhilosophy(root);
  } else if (isLanding) {
    cleanup = renderLanding(root);
  } else {
    cleanup = renderHome(root);
  }
}

// One React root for Privy, mounted outside the router element so navigation
// never unmounts the session.
mountAuth();

window.addEventListener('hashchange', route);
route();

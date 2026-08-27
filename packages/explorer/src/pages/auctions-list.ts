// Every auction anyone has created, read from the chain.
//
// The list comes from the factory's AuctionCreated logs rather than a server.
// That is the point: an index held in one database is exactly as available, and
// exactly as honest, as that database, which is the wrong property for the part
// of a trust-minimised product that tells you what exists.
//
// Logs are read from the factory's deployment block, a known constant. Reading
// from zero is what made the first bid loader time out on this chain.
import {
  hoodiChain,
  HOODI,
  readListings,
  useCaseLabel,
  type AuctionListing,
} from 'peal-auctionkit';
import { createPublicClient, formatUnits, http } from 'viem';
import { esc, truncMiddle } from '../util';

type Cleanup = () => void;

const pub = createPublicClient({
  chain: hoodiChain,
  transport: http(undefined, { timeout: 15_000, retryCount: 2 }),
  batch: { multicall: { wait: 16 } },
});

function when(startTime: bigint, endTime: bigint, now: bigint): { label: string; tone: string } {
  if (now < startTime) return { label: 'opens soon', tone: 'soon' };
  if (now >= endTime) return { label: 'bidding closed', tone: 'closed' };
  const mins = Number(endTime - now) / 60;
  if (mins < 60) return { label: `closes in ${Math.ceil(mins)}m`, tone: 'open' };
  const hrs = mins / 60;
  return { label: hrs < 48 ? `closes in ${Math.round(hrs)}h` : `closes in ${Math.round(hrs / 24)}d`, tone: 'open' };
}

function card(l: AuctionListing, now: bigint): string {
  const w = when(l.startTime, l.endTime, now);
  return `<a class="sl-alist-card" href="#/a/${l.auction}">
    <div class="sl-alist-head">
      <span class="sl-alist-use">${esc(useCaseLabel(l.useCase))}</span>
      <span class="sl-alist-when sl-alist-${w.tone}">${esc(w.label)}</span>
    </div>
    <h3 class="sl-alist-name">${esc(l.name || 'untitled auction')}</h3>
    ${l.details ? `<p class="sl-alist-details">${esc(l.details)}</p>` : ''}
    <dl class="sl-alist-kv">
      <dt>for sale</dt><dd>${esc(formatUnits(l.totalSupply, 18))}</dd>
      <dt>issuer</dt><dd class="mono">${esc(truncMiddle(l.issuer, 6, 4))}</dd>
    </dl>
  </a>`;
}

export function renderAuctionsList(root: HTMLElement): Cleanup {
  let stopped = false;
  const prevTitle = document.title;
  document.title = 'SealBid. every auction';

  const draw = (body: string): void => {
    if (stopped) return;
    root.innerHTML = `<div class="ml sl">
      <section class="ml-section sl-alist-top">
        <div class="ml-wrap">
          <p class="ml-sec-kicker">sealbid</p>
          <h1 class="ml-h2 sl-alist-h1">every auction</h1>
          <p class="ml-sub sl-alist-sub">
            read from the factory's own logs on ${esc(HOODI.name)}, not from a server. anyone can
            create one, and anyone can verify this list without asking us.
          </p>
          <div class="ml-hero-ctas">
            <a class="ml-btn ml-btn-dark" href="#/create">create an auction</a>
            <a class="ml-btn" href="${HOODI.explorer}/address/${HOODI.factory}" target="_blank" rel="noopener">the factory onchain</a>
          </div>
          ${body}
        </div>
      </section>
    </div>`;
  };

  draw('<p class="ak-status ak-info">Reading the chain.</p>');

  void (async () => {
    try {
      const listings = await readListings(pub, HOODI.factory, HOODI.factoryBlock);
      const now = BigInt(Math.floor(Date.now() / 1000));
      draw(
        listings.length
          ? `<div class="sl-alist">${listings.map((l) => card(l, now)).join('')}</div>`
          : `<div class="sl-alist-empty">
               <p><b>No auctions yet.</b> The first one anyone creates will appear here.</p>
             </div>`,
      );
    } catch (e) {
      const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
      draw(`<p class="ak-status ak-error">${esc(String(m).split('\n')[0]!)}</p>`);
    }
  })();

  return () => {
    stopped = true;
    document.title = prevTitle;
  };
}

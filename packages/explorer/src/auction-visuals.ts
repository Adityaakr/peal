// 3D visuals for the auction page.
//
// One rule governs all of it: **never render a number the chain has not told
// us.** A sealed bid's quantity and price are not "loading" and not zero — they
// are unknowable, to us and to everyone, until the auction closes. That is the
// entire product, so the visuals have to show absence as a *state*, not as an
// empty value that a reader might mistake for data.
//
// So sealed cards show only what is genuinely public — the commitment hash, the
// escrow, the bidder, the block — behind a frosted face. At reveal they flip in
// 3D and the real numbers arrive. The flip is not decoration; it is the moment
// the information actually changes hands.
import { animate, stagger } from 'motion';
import { esc, truncMiddle } from './util';

export interface WallBid {
  bidId: number;
  bidder: string;
  commitment: string;
  escrow: string;
  sealed: boolean;
  voided: boolean;
  quantity?: string;
  price?: string;
  allocation?: string;
  isMine: boolean;
}

/** Mouse-tracked tilt. Subtle by design — a card that swings around is harder
 * to read, and the numbers on it are the point. */
export function attachTilt(scene: HTMLElement): () => void {
  let raf = 0;
  const onMove = (e: MouseEvent): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = scene.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      scene.style.setProperty('--tilt-x', `${(-py * 7).toFixed(2)}deg`);
      scene.style.setProperty('--tilt-y', `${(px * 9).toFixed(2)}deg`);
    });
  };
  const onLeave = (): void => {
    scene.style.setProperty('--tilt-x', '0deg');
    scene.style.setProperty('--tilt-y', '0deg');
  };
  scene.addEventListener('mousemove', onMove);
  scene.addEventListener('mouseleave', onLeave);
  return () => {
    scene.removeEventListener('mousemove', onMove);
    scene.removeEventListener('mouseleave', onLeave);
    if (raf) cancelAnimationFrame(raf);
  };
}

export function bidWallHtml(bids: WallBid[], quoteSymbol: string, saleSymbol: string): string {
  if (!bids.length) {
    return `<div class="ak-wall-empty">
      <div class="ak-vault"><span></span><span></span><span></span></div>
      <p><strong>No bids yet.</strong> The first sealed bid appears here the moment it lands onchain.</p>
    </div>`;
  }

  const cards = bids
    .map((b) => {
      const face = b.sealed
        ? `<div class="ak-card3d-face ak-face-sealed">
             <div class="ak-seal-badge">sealed</div>
             <div class="ak-hash" title="${esc(b.commitment)}">${esc(truncMiddle(b.commitment, 10, 8))}</div>
             <dl class="ak-kv">
               <dt>Escrow</dt><dd>${esc(b.escrow)} ${esc(quoteSymbol)}</dd>
               <dt>Quantity</dt><dd class="ak-unknown">hidden until close</dd>
               <dt>Max price</dt><dd class="ak-unknown">hidden until close</dd>
             </dl>
             <div class="ak-shimmer"></div>
           </div>`
        : `<div class="ak-card3d-face ak-face-open${b.voided ? ' ak-face-void' : ''}">
             <div class="ak-seal-badge">${b.voided ? 'voided' : 'revealed'}</div>
             <dl class="ak-kv">
               <dt>Quantity</dt><dd>${esc(b.quantity ?? 'n/a')} ${esc(saleSymbol)}</dd>
               <dt>Max price</dt><dd>${esc(b.price ?? 'n/a')} ${esc(quoteSymbol)}</dd>
               <dt>${b.voided ? 'Refund' : 'Allocated'}</dt>
               <dd>${b.voided ? `${esc(b.escrow)} ${esc(quoteSymbol)}` : `${esc(b.allocation ?? 'n/a')} ${esc(saleSymbol)}`}</dd>
             </dl>
           </div>`;

      return `<article class="ak-card3d${b.isMine ? ' ak-mine' : ''}${b.sealed ? '' : ' ak-open'}" data-bid="${b.bidId}">
        <div class="ak-card3d-inner">
          <div class="ak-card3d-id">#${b.bidId}${b.isMine ? ' <span class="ak-you">you</span>' : ''}</div>
          ${face}
          <div class="ak-card3d-addr">${esc(truncMiddle(b.bidder, 6, 4))}</div>
        </div>
      </article>`;
    })
    .join('');

  return `<div class="ak-wall">${cards}</div>`;
}

/** Entry animation. Cards rise and settle rather than fading, so a new bid
 * landing is visible in peripheral vision without stealing the page. */
export function animateWall(scene: HTMLElement): void {
  const cards = scene.querySelectorAll('.ak-card3d');
  if (!cards.length) return;
  animate(
    cards,
    { opacity: [0, 1], transform: ['translateY(26px) rotateX(-14deg)', 'translateY(0) rotateX(0deg)'] },
    { duration: 0.5, delay: stagger(0.05), easing: [0.16, 1, 0.3, 1] } as never,
  );
}

export interface LadderRow {
  tick: number;
  price: string;
  demand: number;
  isClearing: boolean;
}

/** The demand ladder.
 *
 * `rows === null` means the book is still sealed. It renders a deliberately
 * inert ladder in that case: the prices are real (they are auction config), the
 * demand is not shown at all rather than shown as zero. */
export function ladderHtml(rows: LadderRow[] | null, prices: { tick: number; price: string }[]): string {
  if (!rows) {
    const bars = prices
      .map(
        (p) => `<div class="ak-lrow ak-lrow-sealed">
          <span class="ak-lprice">${esc(p.price)}</span>
          <div class="ak-lbar"><div class="ak-lfill ak-lfill-sealed"></div></div>
          <span class="ak-lval">?</span>
        </div>`,
      )
      .reverse()
      .join('');
    return `<div class="ak-ladder ak-ladder-sealed">
      <p class="ak-ladder-note">Demand at every price is <strong>unknown until the auction closes</strong>. Not hidden by
      this page, but genuinely not derivable from anything onchain. That is the guarantee.</p>
      <div class="ak-lrows">${bars}</div>
    </div>`;
  }

  const max = Math.max(1, ...rows.map((r) => r.demand));
  const bars = rows
    .map(
      (r) => `<div class="ak-lrow${r.isClearing ? ' ak-lrow-clearing' : ''}">
        <span class="ak-lprice">${esc(r.price)}</span>
        <div class="ak-lbar"><div class="ak-lfill" style="--w:${((r.demand / max) * 100).toFixed(1)}%"></div></div>
        <span class="ak-lval">${r.demand ? r.demand.toLocaleString(undefined, { maximumFractionDigits: 0 }) : ''}</span>
      </div>`,
    )
    .reverse()
    .join('');
  return `<div class="ak-ladder"><div class="ak-lrows">${bars}</div></div>`;
}

export function animateLadder(scene: HTMLElement): void {
  const fills = scene.querySelectorAll<HTMLElement>('.ak-lfill:not(.ak-lfill-sealed)');
  if (!fills.length) return;
  fills.forEach((f) => {
    const w = f.style.getPropertyValue('--w') || '0%';
    animate(f, { width: ['0%', w] }, { duration: 0.7, easing: [0.16, 1, 0.3, 1] } as never);
  });
}

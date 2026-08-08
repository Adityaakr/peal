// The encrypted-mempool landing page. A faithful vanilla-TS port of the Peal
// design system's "Mempool Landing v2" UI kit: the split-mempool hero (public
// glass waiting room vs sealed batch, sandwich then bloom loop), the footnoted
// problem stats, the public-mempool attack story (3 steps), the peal privacy
// story (4 steps, real on-chain artifacts), the batched-vs-others comparison
// with the O(n) diagram, and the closing CTA band.
import { mountScrollReveal } from '../reveal';

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- small brand components (inline svg/html) --------------------------

function reticle(): string {
  return `<span class="ml-reticle" aria-hidden="true">
    <svg viewBox="0 0 26 26" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="13" cy="13" r="8"/><path d="M13 1v5M13 20v5M1 13h5M20 13h5"/>
      <circle cx="13" cy="13" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
    <span class="ml-reticle-x" aria-hidden="true">
      <svg viewBox="0 0 26 26" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 7l12 12M19 7L7 19"/></svg>
    </span>
  </span>`;
}

// A static red crosshair for the exposed order card in the public story.
function miniReticle(): string {
  return `<span class="ml-mini-reticle" aria-hidden="true">
    <svg viewBox="0 0 26 26" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="13" cy="13" r="8"/><path d="M13 1v5M13 20v5M1 13h5M20 13h5"/>
      <circle cx="13" cy="13" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
  </span>`;
}

function cueTag(text: string): string {
  return `<span class="ml-cue"><span class="ml-cue-mark" aria-hidden="true">&#x26D3;</span>${text}</span>`;
}

// Copyable hash: mono over a dashed underline; flips green briefly on copy.
function truncMiddle(s: string, head: number, tail: number): string {
  if (!s || s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
function hashCopy(value: string, head = 12, tail = 10): string {
  return `<button type="button" class="ml-hash" data-copy="${value}" title="copy">${truncMiddle(value, head, tail)}</button>`;
}

function operatorDots(total: number, done: number, label: string): string {
  let dots = '';
  for (let i = 0; i < total; i++) {
    dots += `<span class="ml-opdot${i < done ? ' ml-opdot-on' : ''}"></span>`;
  }
  return `<span class="ml-opdots">${dots}<span class="ml-opdots-label">${label}</span></span>`;
}

// n operator dots in a ring; lit dots are landed shares; a green check appears
// in the center once the threshold t is met, otherwise a lit/t counter.
function committeeRing(n: number, t: number, lit: number): string {
  const size = 120;
  const r = size / 2 - 10;
  const cx = size / 2;
  const cy = size / 2;
  const met = lit >= t;
  let dots = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    const on = i < lit;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${on ? 'var(--accent)' : '#fff'}" stroke="${on ? 'var(--accent)' : 'var(--border)'}" stroke-width="1.5"/>`;
  }
  const center = met
    ? `<g><circle cx="${cx}" cy="${cy}" r="16" fill="var(--green-weak)" stroke="var(--green)" stroke-width="1.5"/><path d="M ${cx - 6} ${cy} l 4.5 4.5 l 8 -9" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`
    : `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="ml-cring-count">${lit}/${t}</text>`;
  return `<svg class="ml-cring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--accent-border)" stroke-width="1" stroke-dasharray="2 4"/>
    ${dots}${center}
  </svg>`;
}

// O(n) vs O(n·B): an n×B spray on the left, one pellet per operator on the right.
function onDiagram(n = 5, b = 8, width = 420): string {
  const half = width / 2 - 10;
  const rowH = 22;
  const pad = 8;
  const h = n * rowH + pad * 2 + 34;
  let left = '';
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < b; j++) {
      const cx = 30 + j * ((half - 60) / (b - 1));
      const cy = pad + 28 + i * rowH;
      left += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="2.2" fill="var(--muted-soft)"/>`;
    }
  }
  let right = '';
  for (let i = 0; i < n; i++) {
    const cy = pad + 28 + i * rowH;
    right += `<circle cx="${half + 40}" cy="${cy}" r="3" fill="var(--accent)"/>`;
    right += `<line x1="${half + 46}" y1="${cy}" x2="${width - 70}" y2="${h / 2 + 8}" stroke="var(--accent-border)" stroke-width="1"/>`;
  }
  return `<svg class="ml-ondiag" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">
    <text x="${half / 2}" y="14" text-anchor="middle" class="ml-ondiag-cap ml-ondiag-muted">per-tx · O(n·B)</text>
    ${left}
    <text x="${half + 20 + half / 2}" y="14" text-anchor="middle" class="ml-ondiag-cap ml-ondiag-accent">batched · O(n)</text>
    ${right}
    <rect x="${width - 66}" y="${h / 2 - 8}" width="52" height="32" rx="8" fill="var(--accent-weak)" stroke="var(--accent-border)"/>
    <text x="${width - 40}" y="${h / 2 + 12}" text-anchor="middle" class="ml-ondiag-cap ml-ondiag-accent">batch</text>
    <line x1="${half + 10}" y1="8" x2="${half + 10}" y2="${h - 8}" stroke="var(--border)" stroke-width="1"/>
  </svg>`;
}

// ---- hero stage cards --------------------------------------------------

const PUBLIC_TXS = [
  { from: '0x8a…f3', to: 'Uniswap', what: 'swap 12.4 ETH → USDC', meta: 'slippage 0.5% · gas 34 gwei' },
  { from: '0x41…9c', to: 'Aave', what: 'repay 8,200 USDC', meta: 'gas 22 gwei' },
  { from: '0xd2…07', to: 'Uniswap', what: 'swap 950 USDC → WBTC', meta: 'slippage 0.3% · gas 28 gwei' },
  { from: '0x6b…e1', to: 'ENS', what: 'register vault.eth', meta: 'gas 19 gwei' },
];

const SEALED = [
  { slot: 27, header: 'a1c9…e2', sender: '0x8a…f3', gas: '210k', size: '1.2 kb', open: 'swap 12.4 ETH → USDC · slippage 0.5%' },
  { slot: 9, header: '7f04…b8', sender: '0x41…9c', gas: '96k', size: '0.9 kb', open: 'repay 8,200 USDC to Aave' },
  { slot: 41, header: 'c35a…11', sender: '0xd2…07', gas: '184k', size: '1.4 kb', open: 'swap 950 USDC → WBTC · slippage 0.3%' },
  { slot: 55, header: '02de…9f', sender: '0x6b…e1', gas: '61k', size: '0.8 kb', open: 'register vault.eth' },
];

function publicCard(tx: (typeof PUBLIC_TXS)[number], victim = false): string {
  return `<div class="ml-pub-card${victim ? ' ml-pub-victim' : ''}">
    <div class="ml-pub-top"><span class="mono ml-muted">from ${tx.from}</span><span class="ml-arrow">→</span><span class="ml-strong">${tx.to}</span></div>
    <div class="ml-strong">${tx.what}</div>
    <div class="ml-pub-meta">${tx.meta}</div>
    ${victim ? `<span class="mono ml-loss">-$412</span>` : ''}
  </div>`;
}

function botCard(label: string): string {
  return `<div class="ml-bot"><span class="mono">bot 0xee…42</span><span class="ml-strong">${label}</span></div>`;
}

function sealedCard(s: (typeof SEALED)[number]): string {
  return `<div class="ml-sealed">
    <div class="ml-sealed-top">
      <span class="mono ml-slot">slot ${String(s.slot).padStart(2, '0')}</span>
      <span class="mono ml-hdr">&#x2B21; <b>${s.header}</b></span>
      ${cueTag('block 23,401,882')}
      <span class="mono ml-size">${s.size}</span>
    </div>
    <div class="ml-sealed-env mono">
      <span>sender ${s.sender}</span><span>gas ${s.gas}</span>
      <span class="ml-shares">shares <b class="ml-shares-n">0/5</b></span>
    </div>
    <div class="ml-sealed-payload">
      <span class="ml-payload-bars" aria-hidden="true"></span>
      <span class="mono ml-payload-label">payload sealed</span>
      <span class="ml-payload-open">${s.open}</span>
      <span class="ml-payload-verified">✓ verified</span>
    </div>
  </div>`;
}

// ---- story step cards --------------------------------------------------

type Row = { label: string; value: string; tone?: 'bad' | 'good' | 'link' };
type Step = {
  n: string;
  danger?: boolean;
  title: string;
  chip: string;
  chipTone?: 'red' | 'blue' | 'green';
  body: string;
  rows: Row[];
  visual: string;
};

function ledgerRow(r: Row): string {
  const tone = r.tone ? ` ml-lrow-${r.tone}` : '';
  return `<div class="ml-lrow"><span class="ml-lrow-label">${r.label}</span><span class="ml-lrow-value${tone}">${r.value}</span></div>`;
}

function stepCard(s: Step): string {
  const tone = s.chipTone || (s.danger ? 'red' : 'blue');
  return `<div class="ml-scard">
    <span class="ml-scard-num${s.danger ? ' ml-scard-num-danger' : ''}">${s.n}</span>
    <div class="ml-scard-body${s.danger ? ' ml-scard-body-danger' : ''}">
      <div class="ml-scard-visual">${s.visual}</div>
      <div class="ml-scard-main">
        <div class="ml-scard-head"><h3 class="ml-scard-title">${s.title}</h3><span class="ml-scard-chip ml-chip-${tone}">${s.chip}</span></div>
        <p class="ml-scard-copy">${s.body}</p>
        <div class="ml-ledger">${s.rows.map(ledgerRow).join('')}</div>
      </div>
    </div>
  </div>`;
}

// -- story visuals --

function orderCard(): string {
  return `<div class="ml-order-card">25,000 USDC <span class="ml-order-arrow">→</span> ETH<span class="ml-order-reticle">${miniReticle()}</span></div>`;
}

function sandwichStack(closed = false): string {
  const last = closed
    ? `<div class="ml-sand-bar ml-sand-red">searcher sells</div>`
    : `<div class="ml-sand-bar ml-sand-next">next in line…</div>`;
  return `<div class="ml-sand">
    <div class="ml-sand-bar ml-sand-red">searcher buys</div>
    <div class="ml-sand-bar ml-sand-blue">your swap</div>
    ${last}
  </div>`;
}

function slotGrid(): string {
  let cells = '';
  for (let i = 0; i < 64; i++) cells += `<span class="ml-scell${i === 27 ? ' ml-scell-hot' : ''}"></span>`;
  return `<div class="ml-slotgrid">${cells}</div>`;
}

function capsulePill(header: string): string {
  return `<div class="ml-cap-pill"><span class="ml-cap-hex mono">&#x2B21; <b>${header}</b></span></div>`;
}

// ---- the page ----------------------------------------------------------

export function renderMempoolLanding(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Network. the mempool goes dark';

  const publicSteps: Step[] = [
    {
      n: '1',
      danger: true,
      title: 'your order is public',
      chip: 'exposed',
      visual: orderCard(),
      body: 'on a normal chain your swap waits in the public mempool in plain sight. anyone watching, including automated searchers, can read the amount, the direction, and the price you are willing to accept, all before it executes.',
      rows: [
        { label: 'you swap', value: '25,000 USDC to ETH' },
        { label: 'you accept as low as', value: '8.1316 ETH' },
        { label: 'the searcher sees', value: 'all of it', tone: 'bad' },
      ],
    },
    {
      n: '2',
      danger: true,
      title: 'the searcher jumps ahead',
      chip: 'front-run',
      visual: sandwichStack(false),
      body: 'seeing your trade coming, the searcher places its own buy just ahead of yours. that pushes the pool price up, so your swap is now lined up to fill at a worse rate than you were quoted.',
      rows: [
        { label: 'front-run', value: 'placed just ahead of your swap' },
        { label: 'effect', value: 'price pushed against you', tone: 'bad' },
      ],
    },
    {
      n: '3',
      danger: true,
      title: 'you fill worse, it takes the spread',
      chip: 'sandwiched',
      visual: sandwichStack(true),
      body: "your swap executes at the price the searcher left behind, and the searcher immediately sells back into it. you receive less than your quote, and that difference, sized to your own slippage limit, is what the sandwich costs you.",
      rows: [
        { label: 'you received', value: '8.1316 ETH', tone: 'bad' },
        { label: 'you were quoted', value: '8.1725 ETH' },
        { label: 'lost to the sandwich', value: '$103.78', tone: 'bad' },
        { label: 'on-chain', value: hashCopy('0x0c61cc8e21f4b7d3a95012ef88544c', 8, 4) },
      ],
    },
  ];

  const pealSteps: Step[] = [
    {
      n: '1',
      title: 'encrypted on your device',
      chip: 'private',
      visual: capsulePill('b8fe…fa'),
      body: "your order is encrypted on your own device before it reaches the network. the amount, the direction, and the token stay sealed inside a ciphertext addressed to the committee's key. no relayer, no node, and no operator ever sees it in the clear.",
      rows: [
        { label: 'ciphertext', value: hashCopy('b8fe056f19a3d27c4e8b913e4224fa', 8, 8) },
        { label: 'the searcher sees', value: 'nothing readable', tone: 'bad' },
      ],
    },
    {
      n: '2',
      title: 'hidden inside a batch',
      chip: 'unlinkable',
      visual: slotGrid(),
      body: 'the ciphertext drops into a fixed batch of 64 slots. the other slots are indistinguishable decoys, so no observer can tell how many real orders are inside, or which slot is yours. your size, your timing, and your intent disappear into the crowd.',
      rows: [
        { label: 'this batch', value: '1 real + 63 decoys = 64 slots' },
        { label: 'your slot', value: 'indistinguishable from the rest' },
      ],
    },
    {
      n: '3',
      title: 'sealed to a distributed committee',
      chip: 't-of-n',
      visual: committeeRing(5, 3, 2),
      body: 'the power to open your batch is split across a committee of independent operators. any 3 of the 5 can open it together, and only once the cue fires. no single operator, and no group smaller than the quorum, can read your order early.',
      rows: [
        { label: 'committee', value: operatorDots(5, 3, 'any 3 of 5') },
        { label: 'params digest', value: hashCopy('1aab2c4871f09de3b52d6c797954', 8, 6) },
        { label: 'committed', value: hashCopy('0xecb511f534b2491c180d95a11f4b2b0fdc1d42ae07', 7, 4) },
      ],
    },
    {
      n: '4',
      title: 'revealed and proven on-chain',
      chip: 'verifiable',
      chipTone: 'green',
      visual: committeeRing(5, 3, 5),
      body: "at the cue, a quorum of operators each return one 48-byte share. together they open the whole batch at once, after the ordering is already fixed, so there is nothing left to front-run. every share is checked with a public pairing equation, and the settlement contract re-derives the batch's merkle root and rejects any mismatch.",
      rows: [
        { label: 'shares', value: '5 of 5 verified', tone: 'good' },
        { label: 'batch opened', value: '1 real order, together' },
        { label: 'merkle root', value: hashCopy('e2f200c2b8d4517a90ce36242396', 8, 6) },
        { label: 'settled', value: hashCopy('0x92b5b5f1c3ad07e64b8812926a', 8, 4) },
      ],
    },
  ];

  root.innerHTML = `
    <div class="ml">
      <section class="ml-hero" id="ml-stage">
        <h1 class="ml-h1 scroll-reveal">the mempool goes dark.</h1>
        <p class="ml-sub scroll-reveal">transactions travel as 48-byte sealed capsules. builders order what they
        cannot read. when the block is final, the whole batch opens at once, and the sandwich never had anything to see.</p>
        <div class="ml-hero-ctas scroll-reveal">
          <a class="ml-btn ml-btn-dark" href="#/encrypted-mempool">try the playground</a>
        </div>

        <div class="ml-stage scroll-reveal">
          <div class="ml-col ml-col-public">
            <div class="ml-col-head"><span class="ml-col-title">public mempool · today</span>${reticle()}</div>
            ${botCard('buy first · same pool')}
            ${publicCard(PUBLIC_TXS[0], true)}
            ${botCard('sell after · pockets the spread')}
            ${publicCard(PUBLIC_TXS[1])}
            ${publicCard(PUBLIC_TXS[2])}
            ${publicCard(PUBLIC_TXS[3])}
            <div class="ml-micro">everything readable · anyone can act first</div>
          </div>
          <div class="ml-col ml-col-peal">
            <div class="ml-col-head">
              <span class="ml-col-title">peal mempool</span>
              <span class="ml-peal-status">
                <span class="ml-cue-live">${cueTag('cue: block 23,401,882')}</span>
                <span class="ml-open-live">batch open · everyone hears it at once</span>
                ${reticle()}
              </span>
            </div>
            ${SEALED.map(sealedCard).join('')}
            <div class="ml-micro">
              <span class="ml-micro-sealed">envelope visible · payload sealed · nothing to front-run</span>
              <span class="ml-micro-open">opened together · already in fixed order</span>
            </div>
          </div>
        </div>

        <p class="ml-thesis scroll-reveal">the searcher's problem is not made harder. <b>it is made empty.</b></p>
      </section>

      <section class="ml-section">
        <div class="ml-wrap ml-stats scroll-reveal">
          <div class="ml-stat"><div class="ml-stat-big">$1.8B+<sup>1</sup></div><div class="ml-stat-small">drained from ethereum users since 2020 via MEV</div></div>
          <div class="ml-stat"><div class="ml-stat-big">$100B+<sup>2</sup></div><div class="ml-stat-small">volume already routed through paid, private (not encrypted) protection</div></div>
          <div class="ml-stat"><div class="ml-stat-big">~3 min<sup>3</sup></div><div class="ml-stat-small">today's only live threshold mempool's average inclusion time</div></div>
        </div>
        <p class="ml-wrap ml-foot scroll-reveal">¹ Shutter / Primev, 2025 (cumulative since 2020) · ² Flashbots Protect + MEV Blocker protected volume · ³ Shutter on Gnosis, Oct 2025</p>
      </section>

      <section class="ml-section">
        <div class="ml-storywrap scroll-reveal">
          <h2 class="ml-story-h2">how the public mempool takes your money</h2>
          <p class="ml-story-sub">the same swap in a normal, readable mempool. three moves, and the searcher wins.</p>
          <div class="ml-story-grid">${publicSteps.map(stepCard).join('')}</div>
        </div>
      </section>

      <section class="ml-section">
        <div class="ml-storywrap scroll-reveal">
          <h2 class="ml-story-h2">how peal keeps your order private</h2>
          <p class="ml-story-sub">four steps, and every value below is a real artifact from your swap, verifiable on-chain.</p>
          <div class="ml-story-grid">${pealSteps.map(stepCard).join('')}</div>
          <div class="ml-story-cta"><a class="ml-btn ml-btn-soft" href="#/encrypted-mempool">verify the full batch, every slot, share and timing →</a></div>
        </div>
      </section>

      <section class="ml-section">
        <div class="ml-wrap scroll-reveal">
          <p class="ml-sec-kicker">why batched</p>
          <h2 class="ml-h2">the moat is one 48-byte value</h2>
          <div class="ml-table-wrap">
            <table class="ml-table">
              <thead><tr><th></th><th>per-transaction threshold</th><th>per-epoch threshold</th><th class="ml-th-peal">batched threshold (peal)</th></tr></thead>
              <tbody>
                <tr><td class="ml-td-key">committee traffic</td><td class="ml-muted">one share per tx · O(n·B)</td><td class="ml-muted">one key per epoch</td><td class="ml-strong">one 48-byte value per operator · O(n)</td></tr>
                <tr><td class="ml-td-key">unincluded txs</td><td class="ml-muted">stay private</td><td class="ml-muted">exposed at epoch key drop</td><td class="ml-strong">stay private</td></tr>
                <tr><td class="ml-td-key">slot/epoch binding</td><td class="ml-muted">none</td><td class="ml-muted">required</td><td class="ml-strong">none</td></tr>
                <tr><td class="ml-td-key">reveal latency</td><td class="ml-muted">grows with load</td><td class="ml-muted">epoch-bound</td><td class="ml-strong">~1s finalize · precompute hidden</td></tr>
              </tbody>
            </table>
          </div>
          <div class="ml-why-bottom">
            ${onDiagram(5, 8, 420)}
            <blockquote class="ml-quote">
              <p>"batched threshold encryption addresses the drawbacks of both per-epoch and per-transaction schemes."</p>
              <cite>the team behind today's only live threshold mempool</cite>
            </blockquote>
          </div>
        </div>
      </section>

      <section class="ml-section ml-cta">
        <div class="ml-wrap scroll-reveal">
          <p class="ml-cta-title">seal now. reveal on cue.</p>
          <div class="ml-hero-ctas">
            <a class="ml-btn ml-btn-dark" href="#/encrypted-mempool">try the playground</a>
          </div>
        </div>
      </section>
    </div>
  `;

  // The hero loop: 10 beats, ~1.1s each. Toggle phase classes on the stage.
  const stage = root.querySelector<HTMLElement>('#ml-stage')!;
  let t = reduced() ? 6 : 0;
  const paint = () => {
    stage.classList.toggle('is-scan', t === 3);
    stage.classList.toggle('is-attack', t >= 4 && t <= 8);
    stage.classList.toggle('is-dissolved', t >= 4);
    stage.classList.toggle('is-finalize', t >= 7);
    stage.classList.toggle('is-bloom', t >= 8);
  };
  paint();
  let timer = 0;
  if (!reduced()) {
    timer = window.setInterval(() => {
      t = (t + 1) % 10;
      paint();
    }, 1100);
  }

  // Copyable hashes: flip the button label to "copied" briefly.
  const onCopy = (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.ml-hash');
    if (!btn) return;
    const full = btn.dataset.copy || '';
    try {
      navigator.clipboard?.writeText(full);
    } catch {
      /* clipboard unavailable */
    }
    const prev = btn.textContent;
    btn.textContent = 'copied';
    btn.classList.add('is-copied');
    window.setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove('is-copied');
    }, 1200);
  };
  root.addEventListener('click', onCopy);

  const cleanupReveal = mountScrollReveal(root);

  return () => {
    if (timer) clearInterval(timer);
    root.removeEventListener('click', onCopy);
    cleanupReveal();
    document.title = previousTitle;
  };
}

// Stakeholder Tokens: a standalone product page for a startup fundraising and
// investor-management platform powered by Peal's sealed-demand primitive.
//
// Like the mempool and auction product pages, this exports its HTML separately
// so the same content can be prerendered for crawlers and readers without JS.
// The only runtime behaviour is the illustrative hero loop and scroll reveal.
import { mountScrollReveal } from '../reveal';

type Cleanup = () => void;

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const COMMITMENTS = [
  { who: 'investor 01', escrow: '1.50m', instruction: '1.50m · up to 32m', allocation: '1.13m' },
  { who: 'investor 02', escrow: '1.20m', instruction: '1.20m · up to 30m', allocation: '0.91m' },
  { who: 'investor 03', escrow: '1.80m', instruction: '1.80m · up to 28m', allocation: '1.36m' },
  { who: 'investor 04', escrow: '1.50m', instruction: '1.50m · up to 27m', allocation: 'refund' },
  { who: 'investor 05', escrow: '0.80m', instruction: '0.80m · up to 35m', allocation: '0.60m' },
];

const LIFECYCLE = [
  {
    n: '01',
    phase: 'issuer + counsel',
    title: 'structure the raise',
    body: 'Form the SPV, fix the allocation size and publish the documents that define the rights, funding conditions and transfer rules.',
  },
  {
    n: '02',
    phase: 'investor',
    title: 'fund the commitment',
    body: 'An eligible investor escrows USDC before entering the book. Every instruction is backed by funds rather than by an expression of interest.',
  },
  {
    n: '03',
    phase: 'peal',
    title: 'seal private demand',
    body: 'The amount and maximum acceptable valuation are encrypted before submission. The issuer, investors and operators see no readable book.',
    peal: true,
  },
  {
    n: '04',
    phase: 'peal + clearing rule',
    title: 'clear once',
    body: 'At the deadline every funded instruction opens together. A rule fixed in advance returns one valuation, allocations and refunds.',
    peal: true,
  },
  {
    n: '05',
    phase: 'platform',
    title: 'issue and manage',
    body: 'Eligible investors claim tokens tied to the signed documents. Capital releases, approvals and reporting follow the agreed schedule.',
  },
  {
    n: '06',
    phase: 'spv',
    title: 'distribute proceeds',
    body: 'Cash received by the SPV follows the contractual waterfall and the holder-eligibility record, with every payment accounted for.',
  },
];

const SCENARIOS = [
  {
    right: 'post-money valuation cap',
    event: 'the launch clears',
    outcome: 'The clearing result sets the SAFE cap and the SPV receives the corresponding claim.',
  },
  {
    right: 'equity financing / SAFE price',
    event: 'the company raises a priced round',
    outcome: 'The SAFE converts using the more favourable economics defined by its price and cap terms.',
  },
  {
    right: 'pro-rata participation',
    event: 'the SPV keeps its exposure',
    outcome: 'The SPV may participate in the new round to maintain its stake, subject to the documented right.',
  },
  {
    right: 'most favoured nation',
    event: 'a later investor gets better terms',
    outcome: 'The SPV can elect the improved economic terms when the MFN clause permits it.',
  },
  {
    right: 'liquidity event',
    event: 'the company is acquired',
    outcome: 'Exit proceeds flow to the SPV and follow the waterfall in the governing documents.',
  },
  {
    right: 'public listing',
    event: 'the company IPOs or direct lists',
    outcome: 'The SPV participates through the SAFE conversion or liquidity mechanics agreed for a listing.',
  },
  {
    right: 'protective covenants',
    event: 'the company sells major IP or assets',
    outcome: 'Consent rights can stop core value being routed away from the instrument holders.',
  },
  {
    right: 'tag-along right',
    event: 'a founder sells a major stake',
    outcome: 'The SPV can participate in the sale on the same terms when its tag-along right applies.',
  },
  {
    right: 'information rights',
    event: 'the company misses reporting',
    outcome: 'The documents can trigger escalation, including a holder proposal over capital still in the vault.',
  },
  {
    right: 'constitutional governance',
    event: 'the company proposes a new token or raise',
    outcome: 'New supply and senior claims follow the holder-approval mechanics fixed in advance.',
  },
  {
    right: 'liquidation priority',
    event: 'the company winds down',
    outcome: 'The SPV receives the documented priority after creditors and before common equity.',
  },
  {
    right: 'assignment',
    event: 'the SPV structure changes',
    outcome: 'The claim can move to an eligible successor entity without breaking its legal chain.',
  },
];

function commitmentRows(): string {
  return COMMITMENTS.map(
    (row) => `<div class="st-bid-row">
      <span class="st-bid-who">${row.who}</span>
      <span class="st-bid-escrow">${row.escrow} <i>USDC</i></span>
      <span class="st-bid-instruction st-swap">
        <span class="st-before"><b class="st-lock" aria-hidden="true"></b> sealed</span>
        <span class="st-after">${row.instruction}</span>
      </span>
      <span class="st-bid-allocation st-swap">
        <span class="st-before">pending</span>
        <span class="st-after">${row.allocation}</span>
      </span>
    </div>`,
  ).join('');
}

function lifecycleCards(): string {
  return LIFECYCLE.map(
    (step) => `<article class="st-life-card${step.peal ? ' st-life-peal' : ''}">
      <div class="st-life-top">
        <span class="st-life-n">${step.n}</span>
        <span class="st-life-phase">${step.phase}</span>
      </div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
    </article>`,
  ).join('');
}

function scenarioCards(): string {
  return SCENARIOS.map(
    (scenario, index) => `<article class="st-scenario">
      <div class="st-scenario-top">
        <span class="st-scenario-n">${String(index + 1).padStart(2, '0')}</span>
        <span class="st-scenario-right">${scenario.right}</span>
      </div>
      <h3>${scenario.event}</h3>
      <p>${scenario.outcome}</p>
    </article>`,
  ).join('');
}

/** Static page body shared by the browser renderer and prerendering. */
export function stakeholderTokensHtml(): string {
  return `<div class="ml st">
    <section class="st-hero" id="st-hero">
      <div class="st-hero-copy">
        <p class="ml-kicker scroll-reveal">stakeholder token platform</p>
        <h1 class="st-h1 scroll-reveal">fundraising with a book nobody can read early.</h1>
        <p class="ml-sub scroll-reveal">startups define the rights. investors fund their commitments.
        peal keeps demand sealed until one clearing valuation can be checked by everyone.</p>
        <div class="st-launch-status scroll-reveal" role="status" aria-label="Stakeholder Tokens coming soon, powered by Peal Network">
          <span class="st-coming-soon">coming soon</span>
          <span class="st-launch-powered">powered by <strong>Peal Network</strong></span>
        </div>
      </div>

      <div class="st-book scroll-reveal" aria-label="Illustration of a funded private book clearing at one valuation">
        <div class="st-book-bar">
          <span class="st-book-identity">
            <span class="st-book-id">STS / 001</span>
            <span class="st-book-name">Northstar Labs</span>
            <span class="st-book-kind">stakeholder round</span>
          </span>
          <span class="st-book-status st-swap">
            <span class="st-before"><i class="st-live-dot"></i>book open</span>
            <span class="st-after"><i class="st-done-dot"></i>cleared</span>
          </span>
        </div>
        <div class="st-book-terms">
          <div><span>raise</span><strong>4.00m USDC</strong></div>
          <div><span>instrument</span><strong>stakeholder token</strong></div>
          <div><span>rule</span><strong>one clearing valuation</strong></div>
          <div><span>close</span><strong class="st-swap"><span class="st-before">04d 06h</span><span class="st-after">final</span></strong></div>
        </div>
        <div class="st-book-grid">
          <div class="st-demand">
            <div class="st-bid-head"><span>participant</span><span>escrowed</span><span>instruction</span><span>result</span></div>
            ${commitmentRows()}
          </div>
          <aside class="st-clearing">
            <span class="st-clear-kicker st-swap"><span class="st-before">private book</span><span class="st-after">clearing result</span></span>
            <div class="st-clear-value st-swap">
              <span class="st-before st-private-value"><i class="st-lock" aria-hidden="true"></i><em>sealed</em></span>
              <span class="st-after">28m</span>
            </div>
            <span class="st-clear-label st-swap"><span class="st-before">valuation hidden</span><span class="st-after">clearing valuation</span></span>
            <dl>
              <div><dt>funded demand</dt><dd class="st-swap"><span class="st-before">sealed</span><span class="st-after">6.80m</span></dd></div>
              <div><dt>allocated</dt><dd class="st-swap"><span class="st-before">pending</span><span class="st-after">4.00m</span></dd></div>
              <div><dt>refunds</dt><dd class="st-swap"><span class="st-before">pending</span><span class="st-after">2.80m</span></dd></div>
            </dl>
            <span class="st-proof st-swap"><span class="st-before">opens at the deadline</span><span class="st-after">✓ result reproducible</span></span>
          </aside>
        </div>
        <div class="st-book-foot">
          <span>simulation · funded in USDC</span>
          <span class="st-foot-state st-swap"><span class="st-before">funded demand is unreadable</span><span class="st-after">revealed demand explains every allocation</span></span>
        </div>
      </div>
    </section>

    <section class="ml-section">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">the product edge</p>
        <h2 class="st-h2">private while pricing. accountable after.</h2>
        <p class="st-lede">Confidentiality is useful only while early knowledge can change the outcome.
        Once the window closes, the allocation should be explainable rather than opaque.</p>
        <div class="st-boundary">
          <article class="st-boundary-card st-boundary-before">
            <span class="st-boundary-time">before the close</span>
            <h3>the demand stays sealed</h3>
            <ul>
              <li><span>raise terms</span><b>public and fixed</b></li>
              <li><span>investor funds</span><b>escrowed</b></li>
              <li><span>amount and valuation</span><b>unreadable</b></li>
              <li><span>book depth</span><b>unreadable</b></li>
            </ul>
          </article>
          <div class="st-boundary-cue" aria-hidden="true"><span>deadline</span><i></i></div>
          <article class="st-boundary-card st-boundary-after">
            <span class="st-boundary-time">after the close</span>
            <h3>the result can be checked</h3>
            <ul>
              <li><span>funded demand</span><b>revealed</b></li>
              <li><span>clearing rule</span><b>published</b></li>
              <li><span>allocation</span><b>reproducible</b></li>
              <li><span>refunds</span><b>accounted for</b></li>
            </ul>
          </article>
        </div>
        <p class="st-disclosure">That disclosure policy is explicit: Peal's normal flow makes the
        sealed instructions public after opening. The product promises no early reading, not permanent secrecy.</p>
      </div>
    </section>

    <section class="ml-section" id="st-lifecycle">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">one operating system</p>
        <h2 class="st-h2">the raise begins before the auction and ends after it.</h2>
        <p class="st-lede">Peal supplies the private-demand and guaranteed-opening layer. The platform
        around it handles the issuer, the money and the holder relationship.</p>
        <div class="st-life-grid">${lifecycleCards()}</div>
      </div>
    </section>

    <section class="ml-section">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">the legal connection</p>
        <h2 class="st-h2">the token records a right. it does not invent one.</h2>
        <div class="st-rights">
          <div class="st-rights-map" aria-label="Company obligations flow through an SPV and signed documents to eligible token holders">
            <div class="st-right-node"><span>company</span><b>obligations</b></div>
            <i aria-hidden="true">→</i>
            <div class="st-right-node st-right-spv"><span>SPV</span><b>receives value</b></div>
            <i aria-hidden="true">→</i>
            <div class="st-right-node"><span>signed documents</span><b>define rights</b></div>
            <i aria-hidden="true">→</i>
            <div class="st-right-node st-right-token"><span>eligible holders</span><b>token records claim</b></div>
          </div>
          <div class="st-rights-copy">
            <div><span>01</span><p><b>Economic rights live in the agreements.</b> The token points to the rights the company and SPV have actually undertaken.</p></div>
            <div><span>02</span><p><b>Eligibility travels with the holder record.</b> Claims and distributions follow the transfer and compliance rules in those documents.</p></div>
            <div><span>03</span><p><b>Transferability is not liquidity.</b> A transferable token does not guarantee a buyer, a market or an exit.</p></div>
          </div>
        </div>
      </div>
    </section>

    <section class="ml-section">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">real startup scenarios</p>
        <h2 class="st-h2">the rights have to survive what happens next.</h2>
        <p class="st-lede">A stakeholder instrument is tested after the raise: when new money arrives,
        a founder sells, the company lists, reporting stops or the business winds down. The structure
        should say what happens before any of those moments occur.</p>
        <div class="st-scenario-grid">${scenarioCards()}</div>
        <p class="st-scenario-note">These are an illustrative rights map, not default token behaviour.
        Each protection exists only when the company, SPV and signed investment documents create it,
        and its operation depends on the chosen jurisdiction.</p>
      </div>
    </section>

    <section class="ml-section">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">a disciplined first release</p>
        <h2 class="st-h2">prove one complete raise.</h2>
        <div class="st-scope">
          <article class="st-scope-now">
            <span>ship first</span>
            <ul>
              <li>one jurisdiction and counsel-reviewed structure</li>
              <li>one chain with USDC funding and escrow</li>
              <li>one clearing rule with exact oversubscription and refund behaviour</li>
              <li>one rights model, capital-release schedule and reporting process</li>
              <li>founder and investor dashboards for the entire lifecycle</li>
            </ul>
          </article>
          <article class="st-scope-later">
            <span>earn later</span>
            <ul>
              <li>unrestricted secondary trading</li>
              <li>multiple investment structures</li>
              <li>complex token governance</li>
              <li>a formal standard across issuers</li>
            </ul>
          </article>
        </div>
        <div class="st-milestone">
          <span>first milestone</span>
          <strong>one legally reviewed raise, with every allocation, refund and investor right accounted for.</strong>
        </div>
      </div>
    </section>

    <section class="ml-section st-cta">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker">powered by peal</p>
        <h2 class="st-h2">build the private book first.</h2>
        <p class="ml-sub">the fundraising platform is larger than the auction. the auction is the part peal makes fair.</p>
        <div class="ml-hero-ctas">
          <a class="ml-btn ml-btn-dark" href="#/create">run a sealed auction</a>
          <a class="ml-btn" href="/developers/auctions">read the auction guide</a>
        </div>
      </div>
    </section>
  </div>`;
}

export function renderStakeholderTokens(root: HTMLElement): Cleanup {
  const previousTitle = document.title;
  document.title = 'Stakeholder tokens. Startup fundraising powered by Peal';
  root.innerHTML = stakeholderTokensHtml();

  const hero = root.querySelector<HTMLElement>('#st-hero');
  let beat = reduced() ? 5 : 0;
  const paint = () => {
    hero?.classList.toggle('is-closing', beat === 3);
    hero?.classList.toggle('is-revealed', beat >= 4);
    hero?.classList.toggle('is-settled', beat >= 5);
  };
  paint();

  let timer = 0;
  if (!reduced()) {
    timer = window.setInterval(() => {
      beat = (beat + 1) % 8;
      paint();
    }, 1250);
  }

  const stopReveal = mountScrollReveal(root);

  return () => {
    if (timer) window.clearInterval(timer);
    stopReveal();
    document.title = previousTitle;
  };
}

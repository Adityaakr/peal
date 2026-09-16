// Peal Links: the product landing page (#/bonsai).
//
// One editorial rule, borrowed from the SealBid landing and held just as
// strictly here: the page may only say what the code in this repository
// actually does. The proofs are real (crates/peal-bonsai over the pinned
// ZK-Pari circuits), the ledger is real, and everything about trust and
// visibility below is copied from docs/peal-links/THREAT_MODEL.md rather than
// softened for a hero. The checkout beside the headline is an illustration
// with fictional data and is labelled as one.
import { mountScrollReveal } from '../reveal';
import { esc } from '../util';
import { getStatus, type LinksStatus } from '../links/api';
import '../links.css';

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- the illustrative checkout ------------------------------------------

type PreviewStage = 'request' | 'proving' | 'accepted';

const PREVIEW = {
  name: 'Mara Okafor',
  title: 'Brand illustration, final files',
  amount: '1,250.00',
  symbol: 'tUSD',
  network: 'local chain A (demo funds)',
  reference: 'INV-0417',
};

function previewStatus(stage: PreviewStage): string {
  switch (stage) {
    case 'request':
      return `<span class="pl-status"><span class="pl-status-dot"></span>awaiting payment</span>`;
    case 'proving':
      return `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>proving on the payer's device</span>`;
    case 'accepted':
      return `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>accepted by the ledger · receipt delivered</span>`;
  }
}

function previewCard(stage: PreviewStage): string {
  const rows =
    stage === 'accepted'
      ? [
          ['amount', `${PREVIEW.amount} ${PREVIEW.symbol}`],
          ['what the ledger stores', 'one 32-byte receipt commitment'],
          ['what the public sees', 'that an account acted, not to whom or how much'],
          ['receiver claims', 'whenever they are next online'],
        ]
      : [
          ['amount', `${PREVIEW.amount} ${PREVIEW.symbol}`],
          ['network', PREVIEW.network],
          ['fee', 'none at this stage of the build'],
          ['reference', PREVIEW.reference],
        ];
  return `
    <div class="pl-preview" id="pl-preview" aria-label="illustrative checkout">
      <span class="pl-preview-tag">illustration · fictional data</span>
      <div class="pl-preview-head">
        <span class="pl-preview-name">${esc(PREVIEW.name)}</span>
        <span class="pl-small">display name, self-chosen</span>
      </div>
      <p class="pl-preview-title">${esc(PREVIEW.title)}</p>
      <div class="pl-amount">${PREVIEW.amount}<span class="pl-amount-unit">${PREVIEW.symbol}</span></div>
      <div class="pl-preview-rows">
        ${rows.map(([l, v]) => `<div class="pl-row"><span class="pl-row-label">${l}</span><span class="pl-row-value">${v}</span></div>`).join('')}
      </div>
      <div id="pl-preview-status">${previewStatus(stage)}</div>
      <div class="pl-preview-foot">
        <span>step through the flow</span>
        <div class="pl-preview-steps" role="group" aria-label="preview stage">
          ${(['request', 'proving', 'accepted'] as PreviewStage[])
            .map(
              (s) =>
                `<button type="button" class="pl-preview-step" data-stage="${s}" aria-pressed="${s === stage}">${s}</button>`,
            )
            .join('')}
        </div>
      </div>
    </div>`;
}

// ---- sections ------------------------------------------------------------

function howItWorks(): string {
  const steps = [
    {
      n: '01',
      t: 'request',
      d: 'You create a payment request: an exact amount, an asset on one backing chain, a title and an optional expiry. Your client signs the request so a payer can check it was not altered on the way.',
    },
    {
      n: '02',
      t: 'pay',
      d: 'The payer opens the link, funds a private balance from their own wallet if they have none, and their browser makes a zero-knowledge proof that moves the amount. The proof is checked by the ledger. The amount and the receiver are inside a commitment, not on the record.',
    },
    {
      n: '03',
      t: 'receive',
      d: 'The receipt opening is encrypted to you and left in your inbox. You can be offline while it happens. When you are back, your client verifies it against the ledger and claims it into your spendable balance.',
    },
  ];
  return `
    <section class="pl-section">
      <div class="pl-wrap scroll-reveal">
        <p class="pl-kicker">how it works</p>
        <h2 class="pl-h2">three steps, one link</h2>
        <div class="pl-grid-3">
          ${steps
            .map(
              (s) => `<div class="pl-card"><div class="pl-card-n">${s.n}</div><h3 class="pl-h3">${s.t}</h3><p class="pl-p">${s.d}</p></div>`,
            )
            .join('')}
        </div>
      </div>
    </section>`;
}

function useCases(): string {
  const cases = [
    {
      t: 'independent work',
      d: 'Send a client one link for the invoice. They pay it from a wallet; you receive it in a balance that does not publish your income to the chain.',
    },
    {
      t: 'business invoices',
      d: 'A reference number on the request, an exact amount, and a receipt you can export when your books need it. Nothing exported unless you choose to.',
    },
    {
      t: 'contributions',
      d: 'A fixed-amount link for a workshop seat, a membership or a collection. Everyone pays the same amount; nobody learns who else paid.',
    },
  ];
  return `
    <section class="pl-section">
      <div class="pl-wrap scroll-reveal">
        <p class="pl-kicker">what it is for</p>
        <h2 class="pl-h2">payments that are yours to disclose</h2>
        <div class="pl-grid-3">
          ${cases.map((c) => `<div class="pl-card"><h3 class="pl-h3">${c.t}</h3><p class="pl-p">${c.d}</p></div>`).join('')}
        </div>
      </div>
    </section>`;
}

function privacy(): string {
  // Copied from THREAT_MODEL.md's observer matrix; keep the two in step.
  return `
    <section class="pl-section">
      <div class="pl-wrap scroll-reveal">
        <p class="pl-kicker">what is visible</p>
        <h2 class="pl-h2">exactly who sees what</h2>
        <p class="pl-p">Peal Links runs on the Bonsai payment construction. Every account on the ledger is one commitment. A payment changes two commitments and appends one receipt, and the proof that it was done correctly is 128 bytes. What follows is the honest list, not the brochure version.</p>
        <div class="pl-table-wrap">
          <table class="pl-table">
            <thead><tr><th>who</th><th>sees</th><th>does not see</th></tr></thead>
            <tbody>
              <tr><td data-label="who">the public ledger</td><td data-label="sees">which account acted, and when</td><td data-label="does not see">the amount, the other party, whether it was a send or a receive</td></tr>
              <tr><td data-label="who">the backing chain</td><td data-label="sees">deposits and withdrawals: address, amount, token</td><td data-label="does not see">which private account a deposit went to, or which payments happened in between</td></tr>
              <tr><td data-label="who">the payer</td><td data-label="sees">the amount, your display name and your wallet address</td><td data-label="does not see">your balance, your other payments</td></tr>
              <tr><td data-label="who">you, the receiver</td><td data-label="sees">the amount and, for a payment to your address, who paid</td><td data-label="does not see">the payer's balance or their other payments</td></tr>
              <tr><td data-label="who">Peal's directory</td><td data-label="sees">which wallet address owns which private account: the signed receiving profile you publish so others can pay your address</td><td data-label="does not see">your payments, amounts or balance</td></tr>
              <tr><td data-label="who">Peal's services</td><td data-label="sees">request titles and amounts you publish, when a request is viewed, encrypted receipt envelopes, submission times and IP addresses</td><td data-label="does not see">the contents of receipts, your spending key, your balance</td></tr>
            </tbody>
          </table>
        </div>
        <p class="pl-small" style="margin-top:14px">Your wallet is your only visible identity here, and Peal's directory links it to your private account so others can pay you; that is a service that knows the link, not cryptographic unlinkability. Not hidden: that your account was active, the timing of your submissions, and the metadata of the connection you submit over. Peal Links does not claim anonymity or metadata privacy. The full observer matrix is in the repository under <span class="pl-mono">docs/peal-links/THREAT_MODEL.md</span>.</p>
      </div>
    </section>`;
}

function developers(): string {
  // The Rust surface that exists today (crates/peal-bonsai). The TypeScript
  // SDK lands in Phase C and this block is replaced by its real example then.
  const code = `<span class="c">// crates/peal-bonsai: what a client does to pay a request</span>
let inst = Instance::default_instance();
let keys = Keys::load(&amp;inst, params_dir)?;          <span class="c">// pinned circuit id</span>
let mut wallet = Wallet::from_json(&amp;stored)?;      <span class="c">// decrypted locally</span>

let root = ledger.receipt_root();                    <span class="c">// from GET /links/v1/ledger</span>
let circuit = wallet.prepare_send(&amp;inst, amount, receiver, root, Some(request_id), now, &amp;mut rng)?;
let envelope = wallet.prove_pending(&amp;keys, circuit, &amp;mut rng)?;   <span class="c">// 128-byte proof</span>
let applied = ledger.apply(&amp;envelope)?;             <span class="c">// verified by the ledger, or rejected</span>
wallet.commit_pending(applied.position, now)?;`;
  return `
    <section class="pl-section">
      <div class="pl-wrap scroll-reveal">
        <p class="pl-kicker">for developers</p>
        <h2 class="pl-h2">a wallet, a ledger, and a proof between them</h2>
        <p class="pl-p">The core is a Rust crate over the pinned upstream ZK-Pari circuits. A wallet holds the account opening and its private list of claimed receipts; the ledger holds one commitment per account and verifies every operation. The example below is the real call sequence from the crate's tests.</p>
        <pre class="pl-code">${code}</pre>
        <p class="pl-small" style="margin-top:12px">Typed TypeScript bindings for the browser are being built on this surface; until they ship, this page does not advertise them.</p>
      </div>
    </section>`;
}

function faq(status: LinksStatus | null): string {
  const networks = status
    ? status.namespaces
        .map(
          (n) =>
            `${esc(n.chain_name)} · ${esc(n.token_symbol)}${n.available ? '' : ' (configured, not available)'}${n.environment !== 'mainnet' ? ` · ${n.environment} funds` : ''}`,
        )
        .join('; ')
    : 'the configured networks are listed by the running node; none are available in this build until the local stack is up.';
  const qa: Array<[string, string]> = [
    [
      'Which networks and assets are supported?',
      `Each asset lives on one backing chain and is not interchangeable with the same symbol elsewhere. Right now: ${networks} Ethereum, Base and Arbitrum profiles exist in configuration and stay unavailable until a deployment has been verified.`,
    ],
    [
      'Why do I need a private balance?',
      'A payment moves value between private accounts on the ledger, so the payer needs a balance there first. Funding is a normal token transfer into the gateway contract; it is credited once the chain has confirmed it. From then on payments do not touch the chain.',
    ],
    [
      'What does claiming a receipt mean?',
      'When someone pays you, the ledger records a receipt commitment and your inbox gets the encrypted opening. Claiming is your client proving to the ledger that the receipt is yours and unclaimed, which adds the amount to your spendable balance. Until then it shows as incoming.',
    ],
    [
      'What if I lose my device?',
      'Your account opening, your spending key and your claimed-receipt list live only on your device and in the encrypted backup you export. Connecting the same wallet on a new device does not recover them; the backup does. Without it, the funds cannot be moved by anyone, including Peal.',
    ],
    [
      'Are there fees?',
      'This build charges no fee on the private ledger. Deposits and withdrawals pay the gas of the backing chain in the usual way. If a fee is introduced it will be shown as a separate line before you confirm.',
    ],
    [
      'Are deposits and withdrawals private?',
      'No. They are ordinary token transfers on the backing chain and are as public as any other. What stays private is everything between them.',
    ],
  ];
  return `
    <section class="pl-section">
      <div class="pl-wrap scroll-reveal">
        <p class="pl-kicker">questions</p>
        <h2 class="pl-h2">the short answers</h2>
        <div class="pl-faq">
          ${qa.map(([q, a]) => `<details><summary>${esc(q)}</summary><p class="pl-p">${a}</p></details>`).join('')}
        </div>
        <p class="pl-attrib">Peal Links is built on the Bonsai private payment construction and its ZK-Pari proof system, published by Commonware. Peal is not affiliated with or endorsed by Commonware. The upstream implementation is pinned by revision in this repository; the trusted setup used here is a local development setup, and the security proofs the construction relies on are stated in the repository's research notes, including what remains unproven.</p>
      </div>
    </section>`;
}

export function bonsaiLandingHtml(status: LinksStatus | null): string {
  const env = status?.namespaces.find((n) => n.available)?.environment ?? null;
  const availability =
    env === 'mainnet'
      ? ''
      : `<p class="pl-small" style="margin-top:14px">${
          env
            ? `This deployment runs on ${env} funds. Nothing here is real money.`
            : 'No payment network is available in this build until the local stack is running. Nothing here moves real money.'
        }</p>`;
  return `
    <div class="pl">
      <div class="pl-wrap">
        <section class="pl-hero">
          <div class="scroll-reveal">
            <span class="pl-product-label">Peal Links</span>
            <h1 class="pl-h1">One link. A private payment.</h1>
            <p class="pl-lead">Create a payment request, share it, and receive funds in your Peal balance. The amount and the parties stay inside a proof; the ledger only learns that it checked out.</p>
            <div class="pl-hero-ctas">
              <a class="pl-btn pl-btn-primary" href="#/bonsai/app">Create a payment link</a>
              <a class="pl-btn" href="#pl-how">How it works</a>
            </div>
            ${availability}
          </div>
          <div class="scroll-reveal">${previewCard('request')}</div>
        </section>
      </div>
      <div id="pl-how"></div>
      ${howItWorks()}
      ${useCases()}
      ${privacy()}
      ${developers()}
      ${faq(status)}
    </div>`;
}

export function renderBonsaiLanding(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. One link, a private payment.';
  let stale = false;
  let cleanupReveal: (() => void) | null = null;
  let timer = 0;

  const mount = (status: LinksStatus | null) => {
    if (stale) return;
    root.innerHTML = bonsaiLandingHtml(status);
    cleanupReveal = mountScrollReveal(root);

    // The preview steps through request -> proving -> accepted on click.
    // Without reduced motion it also advances by itself, once through, so a
    // reader who does not touch it still sees what "accepted" means; it never
    // loops forever.
    const preview = root.querySelector<HTMLElement>('#pl-preview');
    const setStage = (stage: PreviewStage) => {
      if (!preview) return;
      const statusEl = preview.querySelector<HTMLElement>('#pl-preview-status');
      if (statusEl) statusEl.innerHTML = previewStatus(stage);
      const wrapper = preview.parentElement;
      if (wrapper) {
        wrapper.innerHTML = previewCard(stage);
      }
    };
    root.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.pl-preview-step');
      if (!btn) return;
      window.clearTimeout(timer);
      setStage(btn.dataset.stage as PreviewStage);
    });
    if (!reduced()) {
      timer = window.setTimeout(() => {
        setStage('proving');
        timer = window.setTimeout(() => setStage('accepted'), 2200);
      }, 2600);
    }
  };

  // The node is optional for this page: it only refines the FAQ's network
  // list. Render immediately, then once more if the node answers.
  mount(null);
  void getStatus()
    .then((status) => {
      if (stale) return;
      // Re-render only the FAQ's network answer, keeping scroll position.
      const y = window.scrollY;
      if (cleanupReveal) cleanupReveal();
      window.clearTimeout(timer);
      mount(status);
      window.scrollTo({ top: y });
    })
    .catch(() => {
      /* the page already says no network is available */
    });

  return () => {
    stale = true;
    window.clearTimeout(timer);
    if (cleanupReveal) cleanupReveal();
    document.title = previousTitle;
  };
}

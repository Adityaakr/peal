// Peal Links: the product landing page (#/bonsai).
//
// Built on the same structure as the network landing (pages/landing.tsx): a
// rounded hero card with one headline and one call to action, then sections
// that each answer one question, in the order a first-time visitor asks
// them, with a scene drawn in depth between the paragraphs. The scenes reuse
// the landing's stage and card styles so the two pages read as one product.
//
// One editorial rule, held strictly: the page may only say what the code in
// this repository actually does. The proofs are real (crates/peal-bonsai over
// the pinned ZK-Pari circuits), the ledger is real, and everything about
// trust and visibility below is copied from docs/peal-links/THREAT_MODEL.md
// rather than softened for a hero. The checkout in the second section is an
// illustration with fictional data and is labelled as one.
import { mountScrollReveal } from '../reveal';
import { esc } from '../util';
import { getStatus, type LinksStatus } from '../links/api';
import './landing.css';
import '../links.css';

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- the hero -------------------------------------------------------------
//
// The mempool landing's opening: a lowercase display line, one sub line, one
// dark button, and the product's own stage right under it. Here the stage is
// the checkout, stepping through request, proving and accepted, with what
// the public ledger and the receiver see standing behind it.

function fundsNote(status: LinksStatus | null): string {
  const env = status?.namespaces.find((n) => n.available)?.environment ?? null;
  if (env === 'mainnet') return '';
  return env
    ? `this deployment runs on ${esc(env)} funds. nothing here is real money.`
    : 'no payment network is available until a Peal Links node is running. nothing here moves real money.';
}

function hero(status: LinksStatus | null): string {
  const note = fundsNote(status);
  return `
    <section class="ml-hero pl-ld-hero" aria-labelledby="pl-ld-title">
      <h1 class="ml-h1 scroll-reveal" id="pl-ld-title">one link. a private payment.</h1>
      <p class="ml-sub scroll-reveal">share a link, get paid from any wallet. the amount and the two parties stay inside a proof; the ledger only learns that it checked out.</p>
      <div class="ml-hero-ctas scroll-reveal">
        <a class="ml-btn ml-btn-dark" href="#/bonsai/app">create a payment link</a>
        <a class="ml-btn" href="#pl-how">how it works</a>
      </div>
      <div class="scroll-reveal">
        ${checkoutScene('request')}
        <p class="pl-ld-flow-cap" id="pl-ld-flow-cap">step through the flow, or watch it run once</p>
      </div>
      ${note ? `<p class="ml-note pl-ld-note">${note}</p>` : ''}
    </section>`;
}

// ---- section scaffolding --------------------------------------------------

function section(id: string, kicker: string, title: string, body: string): string {
  return `
    <section id="${id}" class="ml-section">
      <div class="ml-wrap scroll-reveal">
        <p class="ml-sec-kicker pl-ld-kicker">${kicker}</p>
        <h2 class="ml-story-h2 pl-ld-h2">${title}</h2>
        <div class="pl-ld-body">${body}</div>
      </div>
    </section>`;
}

function tryRow(href: string, label: string, more: string, moreLabel: string): string {
  return `<p class="pl-ld-try"><a class="ml-btn ml-btn-dark" href="${href}">${label}</a><a class="pl-ld-more" href="${more}">${moreLabel}</a></p>`;
}

// ---- scenes ----------------------------------------------------------------

/** The problem, drawn: four payments on a public chain, every one legible to
 * anyone, forever. Same placement as the landing's open queue. */
function ledgerScene(): string {
  const rows = [
    { v: '1,250.00 USDC', w: 'client → you · invoice' },
    { v: '80.00 USDC', w: 'you → a supplier' },
    { v: '2,400.00 USDC', w: 'client → you · retainer' },
    { v: '15.00 USDC', w: 'read by anyone, forever', last: true },
  ];
  return `
    <div class="peal-scene pl-ld-scene pl-ld-scene-ledger" data-scene="ledger" aria-hidden="true">
      <div class="peal-stage">
        ${rows
          .map(
            (r, i) =>
              `<div class="peal-card peal-card-open${r.last ? ' peal-card-last' : ''}" style="--i:${i}"><span class="peal-card-v">${r.v}</span><span class="peal-card-w">${r.w}</span></div>`,
          )
          .join('')}
      </div>
      <p class="pl-ld-cap">every payment, legible to anyone, forever</p>
    </div>`;
}

/** The checkout, stepping through request, proving and accepted, with what
 * the ledger and the receiver see at each step standing behind it. */
type Stage = 'request' | 'proving' | 'accepted';
const STAGES: Stage[] = ['request', 'proving', 'accepted'];

const PREVIEW = { name: 'Mara Okafor', wallet: '0x8a3f…c21e', title: 'Brand illustration, final files', amount: '1,250.00', symbol: 'USDC', reference: 'INV-0417' };

function stageStatus(stage: Stage): string {
  switch (stage) {
    case 'request':
      return `<span class="pl-status"><span class="pl-status-dot"></span>awaiting payment</span>`;
    case 'proving':
      return `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>proving on the payer's device</span>`;
    case 'accepted':
      return `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>accepted by the ledger · receipt delivered</span>`;
  }
}

const SIDE: Record<Stage, { ledger: [string, string]; receiver: [string, string] }> = {
  request: { ledger: ['nothing yet', 'a link is not a ledger entry'], receiver: ['link shared', 'can close the laptop now'] },
  proving: { ledger: ['waiting for one proof', '128 bytes, made in the browser'], receiver: ['still offline', 'nothing is needed from them'] },
  accepted: { ledger: ['an account acted', 'one 32-byte receipt commitment, no amount, no parties'], receiver: ['encrypted receipt in the inbox', 'claimed when next online'] },
};

function checkoutScene(stage: Stage): string {
  const side = SIDE[stage];
  return `
    <div class="pl-ld-flow${stage === 'accepted' ? ' is-accepted' : ''}" id="pl-ld-flow" data-scene="checkout" data-stage="${stage}">
      <div class="pl-ld-flow-stage" aria-hidden="true">
        <div class="pl-ld-side pl-ld-side-ledger"><span class="pl-ld-side-tag">the public ledger</span><b>${side.ledger[0]}</b><i>${side.ledger[1]}</i></div>
        <div class="pl-ld-checkout" aria-label="illustrative checkout">
          <span class="pl-ld-tag">illustration · fictional data</span>
          <div class="pl-ld-co-head"><span class="pl-ld-co-name">${esc(PREVIEW.name)}</span><span class="pl-ld-co-wallet">wallet ${PREVIEW.wallet}</span></div>
          <p class="pl-ld-co-title">${esc(PREVIEW.title)}</p>
          <div class="pl-ld-co-amount">${PREVIEW.amount}<span>${PREVIEW.symbol}</span></div>
          <div class="pl-ld-co-rows">
            <div class="pl-ld-co-row"><span>reference</span><span>${PREVIEW.reference}</span></div>
            <div class="pl-ld-co-row"><span>fee on the private ledger</span><span>none</span></div>
          </div>
          <div class="pl-ld-co-status">${stageStatus(stage)}</div>
        </div>
        <div class="pl-ld-side pl-ld-side-receiver"><span class="pl-ld-side-tag">the receiver</span><b>${side.receiver[0]}</b><i>${side.receiver[1]}</i></div>
      </div>
      <div class="pl-ld-steps" role="group" aria-label="step through the payment">
        ${STAGES.map((s) => `<button type="button" class="pl-ld-step" data-stage="${s}" aria-pressed="${s === stage}">${s}</button>`).join('')}
      </div>
    </div>`;
}

/** Three moves, each nearer than the last: the landing's handshake pattern. */
function stepsScene(): string {
  const steps = [
    { n: 'request', r: 'one signed link', d: 'an exact amount in one asset, a title, an optional expiry. your account signs it so a payer can check nothing changed on the way.' },
    { n: 'pay', r: 'proved in the browser', d: 'the payer funds a private balance from their wallet if they have none, then their browser makes the proof. the ledger checks it; the amount and the receiver stay inside a commitment.' },
    { n: 'receive', r: 'claimed when you are back', d: 'the receipt opening is encrypted to you and left in your inbox. you can be offline the whole time. your client verifies it against the ledger and claims it.' },
  ];
  return `
    <div class="peal-x4 pl-ld-x4" data-scene="steps" aria-hidden="true">
      ${steps.map((s, i) => `<span class="peal-x4-step" style="--i:${i}"><code>${s.n}</code><b>${s.r}</b><i>${s.d}</i></span>`).join('')}
    </div>`;
}

/** One wallet in front; the private account and its backup behind it. */
function walletScene(): string {
  return `
    <div class="peal-scene pl-ld-scene" data-scene="wallet" aria-hidden="true">
      <div class="peal-stage pl-ld-wallet-stage">
        <div class="peal-card pl-ld-wcard pl-ld-wcard-backup"><span class="peal-card-v">encrypted backup</span><span class="peal-card-w">opens with your wallet's signature, or a recovery code</span></div>
        <div class="peal-card pl-ld-wcard pl-ld-wcard-account"><span class="peal-card-v">private account</span><span class="peal-card-w">one commitment on the ledger · balance sealed on your device</span></div>
        <div class="peal-card pl-ld-wcard pl-ld-wcard-wallet peal-card-last"><span class="peal-card-v">0xf5e0…f41c</span><span class="peal-card-w">your wallet · the only identity anyone sees</span></div>
      </div>
      <p class="pl-ld-cap">one signature authorizes the account behind the wallet; nothing new to install or remember</p>
    </div>`;
}

// ---- sections --------------------------------------------------------------

function problem(): string {
  return section(
    'the-problem',
    'the problem',
    'on a public chain, getting paid is publishing your income.',
    `<p class="ml-p">every transfer carries both addresses and the amount, and it stays there. send a client one address for the invoice and they can read what everyone else paid you, what you paid out, and what you keep.</p>
     ${ledgerScene()}
     <p class="ml-p">the usual answer is a fresh address per invoice. it does not hold up: the moment funds move together, the addresses are one person again, and the record was public the whole time.</p>`,
  );
}

function how(): string {
  return section(
    'pl-how',
    'what Peal Links does',
    'the payment happens inside a proof. the chain only learns it checked out.',
    `<p class="ml-p">a Peal Links payment moves value between private accounts on a small ledger built for it. the payer's browser proves that the amount left their account and reached yours, without saying what the amount was or which account is yours. the ledger checks the proof and records one commitment.</p>
     ${stepsScene()}
     <p class="ml-p">funds come in and go out through ordinary token transfers on the backing chain, which are as public as any other. everything between them is not. a request can be paid once: while one payer is completing it, a second one is asked to wait, and the page updates by itself when the first payment lands.</p>
     ${tryRow('#/bonsai/app', 'create a payment link', '#pl-visible', 'exactly who sees what')}
     <p class="ml-foot pl-ld-fine">the checkout at the top of this page is an illustration with fictional data. the real one at <code>#/pay/…</code> is signed by the payee's account, verified in the payer's browser, and proves the payment with the pinned ZK-Pari circuits from the Bonsai construction; a proof takes a few seconds on a laptop.</p>`,
  );
}

function oneWallet(): string {
  return section(
    'one-wallet',
    'one wallet',
    'your wallet is the only identity. the private account stands behind it.',
    `<p class="ml-p">there is no second address to manage. on first use your wallet signs one authorization for a private account, and from then on it is the thing you connect, the thing people pay, and the thing that recovers you.</p>
     ${walletScene()}
     <p class="ml-p">the account's state lives encrypted on your device and in a backup only your wallet can open. wallets that sign deterministically open it with a signature; the rest get a recovery code, shown once. lose the device, keep the wallet, and the account comes back.</p>`,
  );
}

function visible(): string {
  // Copied from THREAT_MODEL.md's observer matrix; keep the two in step.
  return section(
    'pl-visible',
    'what is visible',
    'exactly who sees what, and who does not.',
    `<p class="ml-p">every account on the ledger is one commitment. a payment changes two commitments and appends one receipt, and the proof that it was done correctly is 128 bytes. this is the honest list, not the brochure version.</p>
     <div class="pl-table-wrap pl-ld-table">
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
     <p class="ml-foot pl-ld-fine">not hidden: that your account was active, the timing of your submissions, and the metadata of the connection you submit over. Peal's directory links your wallet to your private account so others can pay your address; that is a service that knows the link, not cryptographic unlinkability. Peal Links does not claim anonymity or metadata privacy. Withdrawals are released by a committee of signers rather than verified by a proof on the chain, and the product says so wherever it appears. The full observer matrix is in the repository under <code>docs/peal-links/THREAT_MODEL.md</code>.</p>`,
  );
}

function uses(): string {
  const cases = [
    ['independent work', 'one link per invoice. the client pays it from a wallet; you receive it in a balance that does not publish your income to the chain.'],
    ['business invoices', 'a reference on the request, an exact amount, and a receipt you can export when your books need it. nothing exported unless you choose to.'],
    ['contributions', 'a fixed-amount link for a workshop seat, a membership or a collection. everyone pays the same; nobody learns who else paid.'],
    ['paying an address', 'no link at all: send to a wallet address that has activated private receiving, and the amount stays between the two of you.'],
  ];
  return section(
    'what-it-is-for',
    'what it is for',
    'payments that are yours to disclose.',
    `<p class="ml-p">the receipts are yours. export them for your accountant, show one to a client, or show nobody. the chain does not get a copy.</p>
     <ul class="pl-ld-uses">${cases.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join('')}</ul>`,
  );
}

function developers(): string {
  const code = `<span class="c">// packages/links: the sequence the app runs, from the SDK's own tests</span>
<span class="c">// receiver: one wallet signature authorizes a private account behind the wallet</span>
const bob = await LinksAccount.setup(opts, circuitId, walletSigner, 'Bob', recovery);
const request = await bob.createRequest({
  amount: '1250000000', title: 'Logo files', reference: 'INV-7',
});

<span class="c">// payer: the wallet confirms a local payment intent, the browser proves the payment</span>
const paid = await alice.pay({ request }, newIntentId(), { intent, signature });

<span class="c">// receiver, whenever they are next online: verify the encrypted receipt, claim it</span>
await bob.syncInbox();
await bob.claimAll();`;
  return section(
    'for-developers',
    'for developers',
    'a wallet, a ledger, and a proof between them.',
    `<p class="ml-p">the core is a Rust crate over the pinned upstream ZK-Pari circuits, compiled to WebAssembly and driven by a typed TypeScript SDK. a wallet holds the account opening and its private list of claimed receipts; the ledger holds one commitment per account and verifies every operation. amounts are integer base units everywhere.</p>
     <pre class="pl-code pl-ld-code">${code}</pre>
     ${tryRow('#/bonsai/app', 'open the app', '#pl-visible', 'what the ledger learns')}
     <p class="ml-foot pl-ld-fine">the ledger is replicated by Commonware <code>simplex</code> consensus in this build. The proving keys come from a local setup rather than a ceremony, the upstream circuits are a pinned prototype revision, and settlement is committee-attested. All of it is recorded in the repository under <code>docs/peal-links/MAINNET_READINESS.md</code>.</p>`,
  );
}

function faq(status: LinksStatus | null): string {
  const networks = status
    ? status.namespaces
        .map((n) => `${esc(n.chain_name)} · ${esc(n.token_symbol)}${n.available ? '' : ' (configured, not available)'}${n.environment !== 'mainnet' ? ` · ${esc(n.environment)} funds` : ''}`)
        .join('; ')
    : 'the configured networks are listed by the running node; none are available until it is up.';
  const qa: Array<[string, string]> = [
    ['Which networks and assets are supported?', `Each asset lives on one backing chain and is not interchangeable with the same symbol elsewhere. Right now: ${networks}.`],
    ['Why do I need a private balance?', 'A payment moves value between private accounts on the ledger, so the payer needs a balance there first. Funding is a normal token transfer into the gateway contract; it is credited once the chain has confirmed it. The checkout adds exactly what is missing as part of paying. From then on payments do not touch the chain.'],
    ['What does claiming a receipt mean?', 'When someone pays you, the ledger records a receipt commitment and your inbox gets the encrypted opening. Claiming is your client proving to the ledger that the receipt is yours and unclaimed, which adds the amount to your spendable balance. The app claims automatically while it is open; until then the payment shows as incoming.'],
    ['What if I lose my device?', 'Your account state lives encrypted on your device and in a backup the node stores for your wallet. Connect the same wallet on a new device: if it signs deterministically, one signature opens the backup; otherwise you enter the recovery code you were shown at setup. Peal cannot open the backup, and without the wallet or the code nobody can.'],
    ['Can I use more than one wallet?', 'Yes. Each wallet gets its own private account, on the same device or on different ones, and switching wallets switches accounts. Peal never links two of your wallets to each other.'],
    ['Are there fees?', 'This build charges no fee on the private ledger. Deposits and withdrawals pay the gas of the backing chain in the usual way, and the checkout shows the estimate before you confirm. If a ledger fee is introduced it will be shown as a separate line first.'],
    ['Are deposits and withdrawals private?', 'No. They are ordinary token transfers on the backing chain and are as public as any other. What stays private is everything between them.'],
  ];
  return section(
    'questions',
    'questions',
    'the short answers.',
    `<div class="pl-faq pl-ld-faq">${qa.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>
     <p class="ml-foot pl-ld-fine">Peal Links is built on the Bonsai private payment construction and its ZK-Pari proof system, published by Commonware. Peal is not affiliated with or endorsed by Commonware. The upstream implementation is pinned by revision in this repository; the trusted setup used here is a local development setup, and the security proofs the construction relies on are stated in the repository's research notes, including what remains unproven.</p>`,
  );
}

function close(status: LinksStatus | null): string {
  const note = fundsNote(status);
  return `
    <section class="ml-section pl-ld-close">
      <div class="ml-wrap scroll-reveal">
        <h2 class="ml-story-h2 pl-ld-h2">create a link and get paid privately.</h2>
        <p class="ml-story-sub">one wallet signature to set up, and the link is ready to share.</p>
        <div class="ml-hero-ctas">
          <a class="ml-btn ml-btn-dark" href="#/bonsai/app">create a payment link</a>
          <a class="ml-btn" href="#pl-visible">see who sees what</a>
        </div>
        ${note ? `<p class="ml-note">${note}</p>` : ''}
      </div>
    </section>`;
}

export function bonsaiLandingHtml(status: LinksStatus | null): string {
  return `
    <div class="pl pl-ld ml">
      ${hero(status)}
      <div class="pl-ld-main">
        ${problem()}
        ${how()}
        ${oneWallet()}
        ${visible()}
        ${uses()}
        ${developers()}
        ${faq(status)}
        ${close(status)}
      </div>
    </div>`;
}

export function renderBonsaiLanding(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. One link, a private payment.';
  let stale = false;
  let cleanupReveal: (() => void) | null = null;
  let observer: IntersectionObserver | null = null;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
  const clearTimers = () => {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  };

  // The checkout steps through request -> proving -> accepted on click.
  // Once it scrolls into view it also runs through by itself, once, so a
  // reader who does not touch it still sees what "accepted" means. It never
  // loops: a payment is a thing that happens once.
  let auto = true;
  const setStage = (stage: Stage) => {
    const flow = root.querySelector<HTMLElement>('#pl-ld-flow');
    if (!flow) return;
    const started = flow.classList.contains('is-in');
    flow.outerHTML = checkoutScene(stage);
    if (started) root.querySelector('#pl-ld-flow')?.classList.add('is-in');
    const cap = root.querySelector<HTMLElement>('#pl-ld-flow-cap');
    if (cap) cap.textContent = stage === 'accepted' ? 'the ledger kept one commitment; the amount and the parties never left the proof' : stage === 'proving' ? 'the proof is made where the secrets are, in the payer’s browser' : 'step through the flow, or watch it run once';
  };
  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.pl-ld-step');
    if (!btn) return;
    auto = false;
    clearTimers();
    setStage(btn.dataset.stage as Stage);
  });

  const mount = (status: LinksStatus | null) => {
    if (stale) return;
    root.innerHTML = bonsaiLandingHtml(status);
    cleanupReveal = mountScrollReveal(root);

    // Scenes start when they come into view, once each. Under reduced
    // motion they are shown in their final state straight away.
    const start = (el: HTMLElement) => {
      el.classList.add('is-in');
      const kind = el.dataset.scene;
      if (kind === 'steps') {
        const panels = Array.from(el.querySelectorAll<HTMLElement>('.peal-x4-step'));
        if (reduced()) panels.forEach((p) => p.classList.add('is-on'));
        else panels.forEach((p, i) => later(() => p.classList.add('is-on'), 700 + i * 800));
      } else if (kind === 'checkout') {
        if (reduced()) setStage('accepted');
        else if (auto) {
          later(() => auto && setStage('proving'), 2400);
          later(() => auto && setStage('accepted'), 4800);
        }
      }
    };
    const scenes = Array.from(root.querySelectorAll<HTMLElement>('[data-scene]'));
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer?.unobserve(e.target);
          start(e.target as HTMLElement);
        }
      },
      { rootMargin: '0px 0px -15% 0px', threshold: 0.2 },
    );
    for (const s of scenes) observer.observe(s);
  };

  // The node is optional for this page: it only refines the network list
  // and the funds note. Render immediately, then once more if it answers.
  mount(null);
  void getStatus()
    .then((status) => {
      if (stale) return;
      const y = window.scrollY;
      cleanupReveal?.();
      observer?.disconnect();
      clearTimers();
      mount(status);
      window.scrollTo({ top: y });
    })
    .catch(() => {
      /* the page already says no network is available */
    });

  return () => {
    stale = true;
    clearTimers();
    observer?.disconnect();
    cleanupReveal?.();
    document.title = previousTitle;
  };
}

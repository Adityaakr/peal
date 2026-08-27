// Create an auction. This is the page that turns SealBid from a demo into
// something a stranger can use.
//
// Two rules run through it.
//
// Everything the contract will reject is checked here first, in words. The
// contract stays the authority, but an issuer should learn their reveal window
// is too short by reading a sentence, not by paying for a reverted transaction
// and decoding a custom error.
//
// And nothing costs money quietly. Supply, prices and windows are all shown and
// all editable, and the escrow a price ladder implies is spelled out before
// anything is signed.
import {
  USE_CASES,
  createAuction,
  hoodiChain,
  metadataHash,
  validateCreate,
  HOODI,
  HOODI_DEMO,
  HOODI_PERMIT_TOKENS,
  type AuctionConfig,
} from 'peal-auctionkit';
import {
  createPublicClient, createWalletClient, custom, formatUnits, http,
  keccak256, parseUnits, stringToHex, type Address,
} from 'viem';
import { esc } from '../util';

type Cleanup = () => void;

const pub = createPublicClient({
  chain: hoodiChain,
  transport: http(undefined, { timeout: 15_000, retryCount: 2 }),
  batch: { multicall: { wait: 16 } },
});

function ethereum(): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null {
  const w = window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } };
  return w.ethereum ?? null;
}

function brief(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const m = err?.shortMessage ?? err?.details ?? err?.message ?? String(e);
  return m.split('\n')[0]!.trim().slice(0, 200);
}

export function renderAuctionCreate(root: HTMLElement): Cleanup {
  const prevTitle = document.title;
  document.title = 'SealBid. create an auction';

  let account: Address | null = null;
  let busy = false;
  let status = '';
  let statusKind: 'info' | 'error' | 'ok' = 'info';
  let created: Address | null = null;
  let problems: string[] = [];

  async function connect(): Promise<void> {
    const eth = ethereum();
    if (!eth) {
      status = 'No wallet found. Install MetaMask or another EIP-1193 wallet.';
      statusKind = 'error';
      draw();
      return;
    }
    try {
      const accs = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
      account = accs[0] ?? null;
      const hex = `0x${HOODI.chainId.toString(16)}`;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      } catch {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hex, chainName: HOODI.name,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.hoodi.ethpandaops.io'],
            blockExplorerUrls: [HOODI.explorer],
          }],
        });
      }
      status = '';
    } catch (e) {
      status = brief(e);
      statusKind = 'error';
    }
    draw();
  }

  function readForm(): { cfg: AuctionConfig; name: string; useCase: string; details: string } | null {
    const g = (id: string): string => root.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
    if (!account) return null;

    const name = g('c-name');
    const useCase = g('c-usecase');
    const details = g('c-details');
    const now = BigInt(Math.floor(Date.now() / 1000));
    const bidHours = Number(g('c-bid-hours') || '6');
    const revealHours = Number(g('c-reveal-hours') || '4');
    const endTime = now + BigInt(Math.round(bidHours * 3600));

    const cfg: AuctionConfig = {
      issuer: account,
      saleToken: (g('c-sale') || HOODI_PERMIT_TOKENS.saleToken) as Address,
      quoteToken: (g('c-quote') || HOODI_PERMIT_TOKENS.quoteToken) as Address,
      totalSupply: parseUnits(g('c-supply') || '0', 18),
      saleDecimals: 18,
      quoteDecimals: 18,
      reservePrice: parseUnits(g('c-reserve') || '0', 18),
      tickSize: parseUnits(g('c-tick') || '0', 18),
      numTicks: Number(g('c-ticks') || '32'),
      startTime: now,
      endTime,
      revealDeadline: endTime + BigInt(Math.round(revealHours * 3600)),
      minBidQuantity: parseUnits(g('c-min') || '1', 18),
      maxQuantityPerAddress: parseUnits(g('c-cap') || '0', 18),
      maxBids: 256,
      allowlistRoot: `0x${'0'.repeat(64)}`,
      protocolFeeBps: 0,
      feeRecipient: account,
      committeeSetId: HOODI_DEMO.committeeSetId,
      encryptionEpoch: keccak256(stringToHex(`${name}:${useCase}:${now}`)),
      // Bound at creation, so a label shown beside an auction can be checked
      // against what its issuer actually committed to.
      metadataHash: metadataHash(name, useCase, details),
      version: 1,
    };
    return { cfg, name, useCase, details };
  }

  async function submit(): Promise<void> {
    if (busy || !account) return;
    const form = readForm();
    if (!form) return;

    problems = validateCreate(form, BigInt(Math.floor(Date.now() / 1000)));
    if (problems.length) {
      status = '';
      draw();
      return;
    }

    const eth = ethereum();
    if (!eth) return;
    busy = true;
    status = 'Approve the supply, then confirm creation. Two transactions.';
    statusKind = 'info';
    draw();

    try {
      const wallet = createWalletClient({ account, chain: hoodiChain, transport: custom(eth) });
      const res = await createAuction({
        publicClient: pub, walletClient: wallet, account, chain: hoodiChain,
        factory: HOODI.factory, create: form,
      });
      created = res.auction;
      status = '';
      statusKind = 'ok';
    } catch (e) {
      status = brief(e);
      statusKind = 'error';
    } finally {
      busy = false;
      draw();
    }
  }

  function field(id: string, label: string, value: string, note = '', mode = 'text'): string {
    return `<label>${esc(label)}${note ? ` <span>${esc(note)}</span>` : ''}
      <input id="${id}" value="${esc(value)}" inputmode="${mode}" autocomplete="off" /></label>`;
  }

  function draw(): void {
    const shareUrl = created ? `${location.origin}${location.pathname}#/a/${created}` : '';

    root.innerHTML = `<div class="ml sl">
      <section class="ml-section sl-alist-top">
        <div class="ml-wrap sl-create-wrap">
          <p class="ml-sec-kicker">sealbid</p>
          <h1 class="ml-h2 sl-alist-h1">create an auction</h1>
          <p class="ml-sub sl-alist-sub">
            bids stay sealed until your close time, then open together and settle at one price.
            the supply goes into the auction contract and its rules take over. nobody, including
            you, can change them afterwards.
          </p>

          ${created ? `
          <div class="sl-created">
            <h3>your auction is live</h3>
            <p class="ak-hint">share this link. anyone who opens it can bid.</p>
            <div class="sl-share">
              <input id="c-share" readonly value="${esc(shareUrl)}" />
              <button class="ak-btn" id="c-copy">copy</button>
            </div>
            <div class="ml-hero-ctas">
              <a class="ml-btn ml-btn-dark" href="#/a/${created}">open it</a>
              <a class="ml-btn" href="${HOODI.explorer}/address/${created}" target="_blank" rel="noopener">onchain</a>
            </div>
          </div>` : `
          ${account
            ? `<div class="ak-acct"><span class="ak-live-dot"></span><code>${esc(account)}</code></div>`
            : `<div class="ml-hero-ctas"><button class="ml-btn ml-btn-dark" id="c-connect">connect wallet</button></div>`}

          ${problems.length ? `<div class="ak-status ak-error"><b>fix these first</b>
            <ul class="sl-problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
          ${status ? `<p class="ak-status ak-${statusKind}">${esc(status)}</p>` : ''}

          ${account ? `
          <form class="sl-form" id="c-form">
            <div class="sl-fieldset">
              <h3>what you are selling</h3>
              ${field('c-name', 'name', '', 'shown on the listing')}
              <label>use case
                <select id="c-usecase">${USE_CASES.map((u) => `<option value="${u.id}">${esc(u.label)}</option>`).join('')}</select>
              </label>
              ${field('c-details', 'details', '', 'optional')}
            </div>

            <div class="sl-fieldset">
              <h3>tokens</h3>
              ${field('c-sale', 'token you are selling', HOODI_PERMIT_TOKENS.saleToken, 'defaults to the demo token')}
              ${field('c-quote', 'token bidders pay in', HOODI_PERMIT_TOKENS.quoteToken, 'defaults to the demo stablecoin')}
              <p class="ak-hint">the defaults support EIP-2612, so bidders sign once and send one transaction instead of two. a token without it still works, it just costs an extra prompt.</p>
              ${field('c-supply', 'total supply for sale', '1000000', '', 'decimal')}
              <p class="ak-hint">you must hold this amount. creating the auction moves it into the contract in the same transaction, so an auction never exists holding nothing.</p>
            </div>

            <div class="sl-fieldset">
              <h3>price ladder</h3>
              ${field('c-reserve', 'reserve, the lowest price you accept', '1', '', 'decimal')}
              ${field('c-tick', 'step between prices', '0.1', '', 'decimal')}
              ${field('c-ticks', 'number of steps', '32', 'up to 256', 'numeric')}
              <p class="ak-hint" id="c-ladder"></p>
            </div>

            <div class="sl-fieldset">
              <h3>timing</h3>
              ${field('c-bid-hours', 'bidding stays open for', '6', 'hours', 'decimal')}
              ${field('c-reveal-hours', 'reveal window after that', '4', 'hours, at least 1', 'decimal')}
              <p class="ak-hint">the reveal window must clear an hour. a bidder whose bid is wrongly voided needs time to prove it before settlement.</p>
            </div>

            <div class="sl-fieldset">
              <h3>limits</h3>
              ${field('c-min', 'smallest bid allowed', '1', '', 'decimal')}
              ${field('c-cap', 'most one address can bid for', '0', '0 for no cap', 'decimal')}
            </div>

            <button class="ml-btn ml-btn-dark sl-submit" type="submit" ${busy ? 'disabled' : ''}>
              ${busy ? 'working' : 'create and fund the auction'}
            </button>
          </form>` : ''}
          `}

          <p class="sl-create-foot">
            testnet demo. the reveal committee's signing keys are published on purpose so anyone can
            reproduce the demo, which means an auction created here is revealed by a committee anyone
            could impersonate. do not put anything of value behind it.
          </p>
        </div>
      </section>
    </div>`;

    root.querySelector('#c-connect')?.addEventListener('click', () => void connect());
    root.querySelector('#c-form')?.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
    root.querySelector('#c-copy')?.addEventListener('click', () => {
      const el = root.querySelector<HTMLInputElement>('#c-share');
      if (!el) return;
      el.select();
      try { navigator.clipboard?.writeText(el.value); } catch { /* unavailable */ }
    });

    // Show the ladder the numbers actually produce. A reserve and a step are
    // abstract; "1 up to 4.1" is what an issuer is really choosing.
    const ladder = (): void => {
      const el = root.querySelector<HTMLElement>('#c-ladder');
      if (!el) return;
      try {
        const r = parseUnits(root.querySelector<HTMLInputElement>('#c-reserve')?.value || '0', 18);
        const t = parseUnits(root.querySelector<HTMLInputElement>('#c-tick')?.value || '0', 18);
        const n = Number(root.querySelector<HTMLInputElement>('#c-ticks')?.value || '0');
        if (!Number.isFinite(n) || n < 1 || n > 256) { el.textContent = 'steps must be between 1 and 256.'; return; }
        el.textContent = `bidders pick a maximum between ${formatUnits(r, 18)} and ${formatUnits(r + BigInt(n - 1) * t, 18)}. a bid escrows quantity times that maximum and is refunded the difference.`;
      } catch { el.textContent = ''; }
    };
    for (const id of ['c-reserve', 'c-tick', 'c-ticks']) {
      root.querySelector(`#${id}`)?.addEventListener('input', ladder);
    }
    ladder();
  }

  draw();
  return () => { document.title = prevTitle; };
}

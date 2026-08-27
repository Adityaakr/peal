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
  activeChain,
  metadataHash,
  validateCreate,
  ACTIVE,
  DemoTokenAbi,
  type AuctionConfig,
} from 'peal-auctionkit';
import {
  createPublicClient, createWalletClient, custom, formatUnits, http,
  keccak256, parseUnits, stringToHex, type Address,
} from 'viem';
import { session, onAuthChange, type Eip1193Like } from '../auth';
import { recordTx, recordMany, txlogHtml, onTxLogChange } from '../txlog';
import { esc } from '../util';

type Cleanup = () => void;

const pub = createPublicClient({
  chain: activeChain,
  transport: http(undefined, { timeout: 15_000, retryCount: 2 }),
  batch: { multicall: { wait: 16 } },
});

/** The wallet this page transacts with.
 *
 * Privy first: a signed-in user has an embedded wallet the app created and
 * funded, and that is the one that can pay. An injected extension is the
 * fallback for people who arrived with one, so nothing that worked before
 * stops working. */
function ethereum(): Eip1193Like | null {
  const s = session();
  if (s.provider) return s.provider;
  const w = window as unknown as { ethereum?: Eip1193Like };
  return w.ethereum ?? null;
}

/** Put the wallet on the chain we are about to transact against.
 *
 * Privy refuses a transaction whose target chain differs from the wallet's
 * current one, and an embedded wallet starts on whatever the provider's
 * defaultChain says. Calling this before every write is what stops the user
 * meeting "the current chain of the wallet (id: 1) does not match the target
 * chain" on whichever button they happen to press first. */
async function ensureChain(chainId: number): Promise<void> {
  await session().switchChain(chainId);
}

function firstLine(s: string): string {
  return s.split(String.fromCharCode(10))[0]!.trim();
}

/** Read a duration expressed as an amount plus a unit, in hours.
 *
 * Hours-only inputs made a three day auction "72", which is arithmetic an
 * issuer should not have to do and is easy to get wrong by a factor of ten. */
const UNIT_HOURS: Record<string, number> = { minutes: 1 / 60, hours: 1, days: 24 };

/** Unix seconds from a `datetime-local` value.
 *
 * `datetime-local` carries no timezone, and `new Date(value)` parses it in the
 * browser's zone, which is what an issuer meant when they picked a time on
 * their own clock. Returns null rather than NaN on an empty field, so a
 * half-filled form cannot reach the contract as a nonsense deadline. */
function localToUnix(value: string): bigint | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time. */
function unixToLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What a use case actually changes about the form.
 *
 * The contract is generic: supply, a price ladder, and limits. What differs
 * between selling a token and selling fifty NFTs is what those numbers mean
 * and what sensible starting values are. Getting the words wrong makes an
 * issuer translate their own sale into someone else's vocabulary, and that is
 * where the expensive typos come from.
 */
interface Preset {
  /** What the thing being sold is called. */
  supplyLabel: string;
  supplyHint: string;
  supplyDefault: string;
  /** What one unit of it is, for the price ladder. */
  unit: string;
  reserveLabel: string;
  reserveDefault: string;
  tickDefault: string;
  minLabel: string;
  minDefault: string;
  capLabel: string;
  capHint: string;
  capDefault: string;
  /** Shown under the use case, so the choice explains itself. */
  blurb: string;
}

const PRESETS: Record<string, Preset> = {
  'token-launch': {
    supplyLabel: 'tokens for sale', supplyHint: 'the whole amount goes into the contract',
    supplyDefault: '1000000', unit: 'token',
    reserveLabel: 'reserve price per token', reserveDefault: '1', tickDefault: '0.1',
    minLabel: 'smallest bid', minDefault: '100',
    capLabel: 'most one address can buy', capHint: '0 for no cap. a cap spreads the allocation',
    capDefault: '200000',
    blurb: 'everyone names a maximum privately, and every winner pays the same clearing price.',
  },
  'dao-treasury': {
    supplyLabel: 'tokens to sell from the treasury', supplyHint: 'moved into the contract when you create',
    supplyDefault: '500000', unit: 'token',
    reserveLabel: 'lowest price the treasury will accept', reserveDefault: '1', tickDefault: '0.05',
    minLabel: 'smallest bid', minDefault: '1000',
    capLabel: 'most one buyer can take', capHint: 'a cap stops one desk taking the whole block',
    capDefault: '100000',
    blurb: 'the market learns the price once, at settlement, instead of learning your intent weeks early.',
  },
  'nft-primary': {
    supplyLabel: 'number of items', supplyHint: 'how many editions are for sale',
    supplyDefault: '100', unit: 'item',
    reserveLabel: 'reserve price per item', reserveDefault: '0.5', tickDefault: '0.05',
    minLabel: 'smallest bid', minDefault: '1',
    capLabel: 'most one collector can win', capHint: '0 for no cap',
    capDefault: '5',
    blurb: 'no bid tells the next collector where the ceiling is, and the seller cannot bid against their own lot.',
  },
  'rwa-issuance': {
    supplyLabel: 'notional for issue', supplyHint: 'the full size of the issue',
    supplyDefault: '1000000', unit: 'unit',
    reserveLabel: 'lowest price you will accept', reserveDefault: '1', tickDefault: '0.01',
    minLabel: 'minimum ticket', minDefault: '10000',
    capLabel: 'largest single allocation', capHint: '0 for no cap',
    capDefault: '250000',
    blurb: 'pro rata at the clearing tick, computed onchain and checkable afterwards, instead of an arranger deciding.',
  },
  tournament: {
    supplyLabel: 'number of seats', supplyHint: 'how many entries are available',
    supplyDefault: '64', unit: 'seat',
    reserveLabel: 'minimum entry price', reserveDefault: '10', tickDefault: '1',
    minLabel: 'smallest bid', minDefault: '1',
    capLabel: 'most seats one entrant can take', capHint: '0 for no cap',
    capDefault: '1',
    blurb: 'seats go to the highest sealed bids, and everyone who gets one pays the same price.',
  },
  campaign: {
    supplyLabel: 'allocation being raised against', supplyHint: 'the total on offer',
    supplyDefault: '250000', unit: 'unit',
    reserveLabel: 'lowest price you will accept', reserveDefault: '1', tickDefault: '0.05',
    minLabel: 'smallest contribution', minDefault: '50',
    capLabel: 'most one supporter can take', capHint: '0 for no cap',
    capDefault: '25000',
    blurb: 'supporters commit privately, so nobody anchors on what came before them.',
  },
  other: {
    supplyLabel: 'total supply for sale', supplyHint: 'the whole amount goes into the contract',
    supplyDefault: '1000000', unit: 'unit',
    reserveLabel: 'reserve, the lowest price you accept', reserveDefault: '1', tickDefault: '0.1',
    minLabel: 'smallest bid allowed', minDefault: '1',
    capLabel: 'most one address can bid for', capHint: '0 for no cap',
    capDefault: '0',
    blurb: '',
  },
};

function preset(id: string): Preset {
  return PRESETS[id] ?? PRESETS.other!;
}

type TimingMode = 'duration' | 'exact';

function timingMode(): TimingMode {
  const el = document.querySelector<HTMLInputElement>('input[name="c-timing"]:checked');
  return (el?.value as TimingMode) ?? 'duration';
}

/** When bidding closes and when the reveal must be done, however the issuer
 * chose to express it. One function, so the two modes cannot drift apart. */
function schedule(nowSec: bigint): { endTime: bigint; revealDeadline: bigint } {
  if (timingMode() === 'exact') {
    const close = localToUnix((document.getElementById('c-close-at') as HTMLInputElement | null)?.value ?? '');
    const deadline = localToUnix((document.getElementById('c-reveal-at') as HTMLInputElement | null)?.value ?? '');
    const endTime = close ?? nowSec + 6n * 3600n;
    return { endTime, revealDeadline: deadline ?? endTime + 4n * 3600n };
  }
  const bidH = durationHours('c-bid-amount', 'c-bid-unit', 6);
  const revH = durationHours('c-reveal-amount', 'c-reveal-unit', 4);
  const endTime = nowSec + BigInt(Math.round(bidH * 3600));
  return { endTime, revealDeadline: endTime + BigInt(Math.round(revH * 3600)) };
}

function durationHours(amountId: string, unitId: string, fallback: number): number {
  const amount = Number(
    (document.getElementById(amountId) as HTMLInputElement | null)?.value ?? '',
  );
  const unit = (document.getElementById(unitId) as HTMLSelectElement | null)?.value ?? 'hours';
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  return amount * (UNIT_HOURS[unit] ?? 1);
}

function brief(e: unknown): string {
  const err = e as {
    shortMessage?: string;
    details?: string;
    message?: string;
    metaMessages?: string[];
    cause?: { shortMessage?: string; reason?: string; message?: string };
  };

  // viem's shortMessage for a revert ends with "reverted with the following
  // signature:" and puts the selector or reason on the NEXT line, so taking
  // only the first line produced the message a user just saw: an error that
  // announces a failure and then says nothing about it.
  const head = err?.shortMessage ?? err?.details ?? err?.message ?? String(e);
  const reason =
    err?.cause?.reason ??
    err?.cause?.shortMessage ??
    err?.metaMessages?.find((m) => m && !/^(Contract Call|Request Arguments)/.test(m.trim()));

  const parts = [firstLine(head)];
  if (reason) {
    const r = firstLine(String(reason));
    if (r && !parts[0]!.includes(r)) parts.push(r);
  }
  return parts.join(' ').slice(0, 300);
}

export function renderAuctionCreate(root: HTMLElement): Cleanup {
  const prevTitle = document.title;
  document.title = 'SealBid. create an auction';

  let account: Address | null = null;
  let busy = false;
  let status = '';
  let statusKind: 'info' | 'error' | 'ok' = 'info';
  let created: Address | null = null;
  let createdTx: `0x${string}` | null = null;
  let problems: string[] = [];
  const funded = new Set<string>();
  /** Read from the tokens themselves, never assumed.
   *
   * These were hardcoded to 18. A payment token with 6 decimals, which is what
   * every real stablecoin uses, would have made every price wrong by a factor
   * of a trillion, and the form would have looked entirely correct while doing
   * it. */
  /** Which pair `meta` describes, so it is not refetched on every keystroke. */
  let metaFor = { sale: '' as string, quote: '' as string };
  let meta = {
    sale: { symbol: ACTIVE.tokens.saleSymbol, decimals: 18 },
    quote: { symbol: ACTIVE.tokens.quoteSymbol, decimals: 18 },
  };

  /** Sign in, then fund, so an issuer can actually pay to create.
   *
   * Creating an auction costs gas and moves the sale supply, so the same
   * argument applies as for bidders: on Tempo a fresh account cannot send
   * anything until it holds PathUSD. */
  async function connect(): Promise<void> {
    const s = session();
    if (!s.ready) {
      status = 'Still starting up. One moment.';
      statusKind = 'info';
      draw();
      return;
    }
    s.login();
  }

  async function fundIfNeeded(addr: Address): Promise<void> {
    if (funded.has(addr.toLowerCase())) return;
    funded.add(addr.toLowerCase());
    // Move the wallet before anything is funded or signed, so the first button
    // a user presses is not the one that discovers the wrong chain.
    try {
      await ensureChain(ACTIVE.chainId);
    } catch { /* reported when a write actually needs it */ }
    try {
      const res = await fetch('/api/fund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: addr, chainId: ACTIVE.chainId }),
      });
      const body = (await res.json()) as { funded?: boolean; error?: string; hashes?: string[] };
      recordMany(body.hashes ?? [], 'Account funded');
      status = body.funded
        ? 'Signed in and funded. You can create an auction.'
        : body.error
          ? `Signed in. Funding did not run: ${body.error}`
          : 'Signed in.';
      statusKind = body.funded ? 'ok' : 'info';
    } catch {
      status = 'Signed in. Could not reach the funding service.';
      statusKind = 'info';
    }
    draw();
  }

  /** Ask each token what it is. Falls back to the deployment's defaults when a
   * token cannot be read, so a typo in an address does not silently produce a
   * form that computes with the wrong scale. */
  async function loadTokenMeta(sale: Address, quote: Address): Promise<void> {
    const one = async (addr: Address, fallbackSymbol: string) => {
      try {
        const [symbol, decimals] = await Promise.all([
          pub.readContract({ address: addr, abi: DemoTokenAbi, functionName: 'symbol' }),
          pub.readContract({ address: addr, abi: DemoTokenAbi, functionName: 'decimals' }),
        ]);
        return { symbol: String(symbol), decimals: Number(decimals) };
      } catch {
        return { symbol: fallbackSymbol, decimals: 18, unreadable: true };
      }
    };
    const [s1, q1] = await Promise.all([
      one(sale, ACTIVE.tokens.saleSymbol),
      one(quote, ACTIVE.tokens.quoteSymbol),
    ]);
    meta = { sale: s1, quote: q1 };
    draw();
  }

  function readForm(): { cfg: AuctionConfig; name: string; useCase: string; details: string } | null {
    const g = (id: string): string => root.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
    if (!account) return null;

    const name = g('c-name');
    const useCase = g('c-usecase');
    const details = g('c-details');
    const now = BigInt(Math.floor(Date.now() / 1000));
    const { endTime, revealDeadline } = schedule(now);

    const cfg: AuctionConfig = {
      issuer: account,
      saleToken: (g('c-sale') || ACTIVE.tokens.saleToken) as Address,
      quoteToken: (g('c-quote') || ACTIVE.tokens.quoteToken) as Address,
      totalSupply: parseUnits(g('c-supply') || '0', meta.sale.decimals),
      saleDecimals: meta.sale.decimals,
      quoteDecimals: meta.quote.decimals,
      // Prices are quoted in the payment token, so they scale by its decimals.
      reservePrice: parseUnits(g('c-reserve') || '0', meta.quote.decimals),
      tickSize: parseUnits(g('c-tick') || '0', meta.quote.decimals),
      numTicks: Number(g('c-ticks') || '32'),
      startTime: now,
      endTime,
      revealDeadline,
      minBidQuantity: parseUnits(g('c-min') || '1', meta.sale.decimals),
      maxQuantityPerAddress: parseUnits(g('c-cap') || '0', meta.sale.decimals),
      maxBids: 256,
      allowlistRoot: `0x${'0'.repeat(64)}`,
      protocolFeeBps: 0,
      feeRecipient: account,
      committeeSetId: ACTIVE.committeeSetId,
      encryptionEpoch: keccak256(stringToHex(`${name}:${useCase}:${now}`)),
      // Bound at creation, so a label shown beside an auction can be checked
      // against what its issuer actually committed to.
      metadataHash: metadataHash(name, useCase, details),
      voidDisputeWindow: BigInt(Math.max(0, Math.round(durationHours('c-dispute-amount', 'c-dispute-unit', 1) * 3600))),
      version: 1,
    };
    return { cfg, name, useCase, details };
  }

  async function submit(): Promise<void> {
    if (busy || !account) return;
    const form = readForm();
    if (!form) return;

    problems = validateCreate(form, BigInt(Math.floor(Date.now() / 1000)));

    // Creating an auction pulls the whole sale supply from the issuer. Check
    // that they hold it, because the onchain failure is a bare transferFrom
    // revert with no reason string, which tells a user nothing about what to
    // do next.
    try {
      const held = (await pub.readContract({
        address: form.cfg.saleToken,
        abi: DemoTokenAbi,
        functionName: 'balanceOf',
        args: [account],
      })) as bigint;
      if (held < form.cfg.totalSupply) {
        problems.push(
          `You are selling ${formatUnits(form.cfg.totalSupply, 18)} of ${form.cfg.saleToken.slice(0, 10)}… but hold ${formatUnits(held, 18)}. ` +
            `Creating an auction moves the whole supply into the contract, so you have to own it first.`,
        );
      }
    } catch {
      problems.push('Could not read your balance of the token you are selling. Check the address is a token on this chain.');
    }

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
      await ensureChain(ACTIVE.chainId);
      const wallet = createWalletClient({ account, chain: activeChain, transport: custom(eth) });
      const res = await createAuction({
        publicClient: pub, walletClient: wallet, account, chain: activeChain,
        factory: ACTIVE.factory, create: form,
      });
      recordTx(res.approvalTx as `0x${string}`, 'Approved the sale supply');
      recordTx(res.createTx, `Created "${form.name}"`);
      createdTx = res.createTx;
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
    // Which use case is selected drives the words and the starting numbers.
    const useCase = root.querySelector<HTMLSelectElement>('#c-usecase')?.value ?? 'token-launch';
    const p = preset(useCase);

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
              <a class="ml-btn" href="${ACTIVE.explorer}/address/${created}" target="_blank" rel="noopener">the contract</a>
              ${createdTx ? `<a class="ml-btn" href="${ACTIVE.explorer}/tx/${createdTx}" target="_blank" rel="noopener">the transaction</a>` : ''}
            </div>
          </div>` : `
          ${account
            ? `<div class="ak-acct"><span class="ak-live-dot"></span><code>${esc(account)}</code></div>`
            : `<div class="ml-hero-ctas"><button class="ml-btn ml-btn-dark" id="c-connect">sign in to create</button></div>`}

          ${problems.length ? `<div class="ak-status ak-error"><b>fix these first</b>
            <ul class="sl-problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
          ${status ? `<p class="ak-status ak-${statusKind}">${esc(status)}</p>` : ''}

          ${account ? `
          <form class="sl-form" id="c-form">
            <div class="sl-fieldset">
              <h3>what you are selling</h3>
              ${field('c-name', 'name', '', 'shown on the listing')}
              <label>use case
                <select id="c-usecase">${USE_CASES.map((u) => `<option value="${u.id}"${u.id === useCase ? ' selected' : ''}>${esc(u.label)}</option>`).join('')}</select>
              </label>
              ${p.blurb ? `<p class="ak-hint">${esc(p.blurb)}</p>` : ''}
              ${field('c-details', 'details', '', 'optional')}
            </div>

            <div class="sl-fieldset">
              <h3>what bidders pay with</h3>
              ${field('c-sale', `token you are selling`, ACTIVE.tokens.saleToken, `read as ${meta.sale.symbol}, ${meta.sale.decimals} decimals`)}
              ${field('c-quote', 'token bidders pay in', ACTIVE.tokens.quoteToken, `read as ${meta.quote.symbol}, ${meta.quote.decimals} decimals`)}
              <p class="ak-hint">the defaults support EIP-2612, so bidders sign once and send one transaction instead of two. a token without it still works, it just costs an extra prompt.</p>
            </div>

            <div class="sl-fieldset">
              <h3>${esc(p.supplyLabel)}</h3>
              ${field('c-supply', esc(p.supplyLabel), p.supplyDefault, esc(p.supplyHint), 'decimal')}
              <p class="ak-hint">you must hold this much ${esc(meta.sale.symbol)}. creating the auction moves it into the contract in the same transaction, so an auction never exists holding nothing.</p>
            </div>

            <div class="sl-fieldset">
              <h3>price ladder</h3>
              ${field('c-reserve', esc(p.reserveLabel), p.reserveDefault, `in ${meta.quote.symbol}`, 'decimal')}
              ${field('c-tick', 'step between prices', p.tickDefault, `in ${meta.quote.symbol}`, 'decimal')}
              ${field('c-ticks', 'number of steps', '32', 'up to 256', 'numeric')}
              <p class="ak-hint" id="c-ladder"></p>
            </div>

            <div class="sl-fieldset">
              <h3>timing</h3>
              <div class="sl-modes" role="radiogroup" aria-label="how to set the schedule">
                <label class="sl-mode"><input type="radio" name="c-timing" value="duration" checked /> for a duration</label>
                <label class="sl-mode"><input type="radio" name="c-timing" value="exact" /> until a date and time</label>
              </div>

              <div id="c-mode-duration">
                <label>bidding stays open for
                  <div class="sl-duration">
                    <input id="c-bid-amount" value="6" inputmode="decimal" autocomplete="off" />
                    <select id="c-bid-unit">
                      <option value="minutes">minutes</option>
                      <option value="hours" selected>hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                </label>
                <label>reveal window after that <span>at least 1 hour</span>
                  <div class="sl-duration">
                    <input id="c-reveal-amount" value="4" inputmode="decimal" autocomplete="off" />
                    <select id="c-reveal-unit">
                      <option value="minutes">minutes</option>
                      <option value="hours" selected>hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                </label>
              </div>

              <div id="c-mode-exact" hidden>
                <label>bidding closes at
                  <input id="c-close-at" type="datetime-local" value="${esc(unixToLocalInput(Math.floor(Date.now() / 1000) + 6 * 3600))}" />
                </label>
                <label>reveal deadline <span>at least an hour after close</span>
                  <input id="c-reveal-at" type="datetime-local" value="${esc(unixToLocalInput(Math.floor(Date.now() / 1000) + 10 * 3600))}" />
                </label>
                <p class="ak-hint">times are on your own clock. the contract stores them as absolute instants, so a bidder in another timezone sees the same moment.</p>
              </div>

              <label>settlement waits after a voided bid <span>so the bidder can dispute it</span>
                <div class="sl-duration">
                  <input id="c-dispute-amount" value="1" inputmode="decimal" autocomplete="off" />
                  <select id="c-dispute-unit">
                    <option value="minutes">minutes</option>
                    <option value="hours" selected>hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
              </label>
              <p class="ak-hint" id="c-dispute-note"></p>

              <p class="ak-hint" id="c-schedule"></p>
            </div>

            <div class="sl-fieldset">
              <h3>limits</h3>
              ${field('c-min', esc(p.minLabel), p.minDefault, `in ${meta.sale.symbol}`, 'decimal')}
              ${field('c-cap', esc(p.capLabel), p.capDefault, esc(p.capHint), 'decimal')}
            </div>

            <button class="ml-btn ml-btn-dark sl-submit" type="submit" ${busy ? 'disabled' : ''}>
              ${busy ? 'working' : 'create and fund the auction'}
            </button>
          </form>` : ''}
          `}

          ${txlogHtml()}

          <p class="sl-create-foot">
            testnet demo. the reveal committee's signing keys are published on purpose so anyone can
            reproduce the demo, which means an auction created here is revealed by a committee anyone
            could impersonate. do not put anything of value behind it.
          </p>
        </div>
      </section>
    </div>`;

    root.querySelector('#c-connect')?.addEventListener('click', () => void connect());

    // Changing the use case re-renders with that preset's words and defaults.
    // Values the issuer already typed are preserved, because silently
    // discarding somebody's numbers because they reclassified their sale is a
    // worse failure than showing a default they have to change.
    root.querySelector('#c-usecase')?.addEventListener('change', () => {
      const keep = ['c-name', 'c-details', 'c-sale', 'c-quote'] as const;
      const held = Object.fromEntries(
        keep.map((id) => [id, root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '']),
      );
      draw();
      for (const [id, v] of Object.entries(held)) {
        const el = root.querySelector<HTMLInputElement>(`#${id}`);
        if (el && v) el.value = v;
      }
    });

    // Ask the tokens what they are, so decimals and symbols come from chain
    // rather than from an assumption that every token looks like the demo one.
    const refreshMeta = (): void => {
      const sale = (root.querySelector<HTMLInputElement>('#c-sale')?.value.trim() || ACTIVE.tokens.saleToken) as Address;
      const quote = (root.querySelector<HTMLInputElement>('#c-quote')?.value.trim() || ACTIVE.tokens.quoteToken) as Address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(sale) || !/^0x[0-9a-fA-F]{40}$/.test(quote)) return;
      if (sale === metaFor.sale && quote === metaFor.quote) return;
      metaFor = { sale, quote };
      void loadTokenMeta(sale, quote);
    };
    root.querySelector('#c-sale')?.addEventListener('change', refreshMeta);
    root.querySelector('#c-quote')?.addEventListener('change', refreshMeta);
    refreshMeta();
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

    // Show the actual clock times, whichever way they were entered. A
    // duration is what an issuer types; a deadline is what they and every
    // bidder have to live with, and the reveal deadline decides whether a
    // stalled reveal refunds everyone.
    const showSchedule = (): void => {
      const el = root.querySelector<HTMLElement>('#c-schedule');
      if (!el) return;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const { endTime, revealDeadline } = schedule(now);
      const fmtWhen = (sec: bigint): string =>
        new Date(Number(sec) * 1000).toLocaleString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });

      const problems: string[] = [];
      if (endTime <= now) problems.push('bidding would close in the past.');
      const disputeSecs = BigInt(Math.max(0, Math.round(durationHours('c-dispute-amount', 'c-dispute-unit', 1) * 3600)));
      if (revealDeadline <= endTime) {
        problems.push('the reveal deadline has to be after bidding closes.');
      } else if (revealDeadline < endTime + disputeSecs) {
        problems.push('the reveal period is shorter than the dispute window you chose, so a late void would leave no time to settle.');
      }

      if (problems.length) {
        el.textContent = problems.join(' ');
        el.className = 'ak-hint ak-error';
        return;
      }
      const hours = Number(revealDeadline - endTime) / 3600;
      el.innerHTML =
        `bidding closes <b>${esc(fmtWhen(endTime))}</b>, and the reveal deadline is ` +
        `<b>${esc(fmtWhen(revealDeadline))}</b>, ${hours.toFixed(hours < 10 ? 1 : 0)} hours later.`;
      el.className = 'ak-hint';
    };

    // Switching mode swaps which inputs are live, so the preview always
    // reflects the fields the issuer can actually see.
    const applyMode = (): void => {
      const exact = timingMode() === 'exact';
      root.querySelector<HTMLElement>('#c-mode-duration')?.toggleAttribute('hidden', exact);
      root.querySelector<HTMLElement>('#c-mode-exact')?.toggleAttribute('hidden', !exact);
      showSchedule();
    };

    // A zero dispute window is legitimate for testing and is a real weakening.
    // Say which it is rather than letting someone set it and find out later.
    const disputeNote = (): void => {
      const el = root.querySelector<HTMLElement>('#c-dispute-note');
      if (!el) return;
      const h = durationHours('c-dispute-amount', 'c-dispute-unit', 1);
      if (h <= 0) {
        el.textContent =
          'zero means the committee can void a bid and settle in the same block, so a wrongly voided bidder has no chance to prove it. their escrow is still refundable, so this is censorship rather than theft. fine for a test, not for a sale carrying value.';
        el.className = 'ak-hint ak-error';
      } else {
        el.textContent =
          `a voided bidder has ${h < 1 ? `${Math.round(h * 60)} minutes` : `${h} hours`} to produce their preimage before settlement. it only delays an auction where something was actually voided.`;
        el.className = 'ak-hint';
      }
      showSchedule();
    };

    for (const id of ['c-dispute-amount', 'c-dispute-unit']) {
      const el = root.querySelector(`#${id}`);
      el?.addEventListener('input', disputeNote);
      el?.addEventListener('change', disputeNote);
    }
    disputeNote();

    for (const id of ['c-bid-amount', 'c-bid-unit', 'c-reveal-amount', 'c-reveal-unit', 'c-close-at', 'c-reveal-at']) {
      const el = root.querySelector(`#${id}`);
      el?.addEventListener('input', showSchedule);
      el?.addEventListener('change', showSchedule);
    }
    for (const el of Array.from(root.querySelectorAll('input[name="c-timing"]'))) {
      el.addEventListener('change', applyMode);
    }
    applyMode();
  }

  const applySession = (): void => {
    const s = session();
    if (s.address && s.address !== account) {
      account = s.address;
      void fundIfNeeded(s.address);
    } else if (!s.address && account) {
      account = null;
      draw();
    } else {
      draw();
    }
  };
  applySession();
  const stopAuth = onAuthChange(applySession);
  const stopTxLog = onTxLogChange(() => draw());

  return () => {
    stopAuth();
    stopTxLog();
    document.title = prevTitle;
  };
}

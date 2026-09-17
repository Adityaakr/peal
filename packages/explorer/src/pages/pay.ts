// Peal Links: public checkout (#/pay/:requestId).
//
// Readable without a wallet. The manifest's signature is verified in the
// payer's own wasm before the amount is trusted, and once the payer is
// signed in the signing key is checked against the payee's receiving
// profile in the directory, so the shortened wallet address shown is the
// verified part; the display name is what the payee chose. Paying is one
// continuous flow: if the private balance is short, the wallet funds the
// difference and the payment follows ("Approve payment", "Adding funds",
// "Preparing payment", "Payment sent"). Progress and intent ids persist so
// a reload resumes without paying twice. Every terminal state is its own
// honest screen.
import type { LinksAccount, PaymentRequest } from 'peal-links';
import { claimTestFunds, depositOnChain, ensureGas, gasSymbol, LinksApiError, newIntentId, paymentIntentTypedData, providerSigner, publicClientFor, testFundsSource, tokenBalance } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, injectedProvider, onAuthChange, resumeInjected, session } from '../auth';
import { esc } from '../util';
import { describeError, formatUnits, fmtTime, shortHex } from '../links/format';
import { acknowledgeRecoveryCode, activate, client, disconnect, ensureWalletChain, links, loadStatus, onLinksChange, recoverWithCode, resumeSignIn, selectNamespace } from '../links/session';
import { connectorLine } from '../links/connectors';
import { avatar, busyBanner, cap } from '../links/ui';
import '../links.css';

function setMeta(name: string, content: string): () => void {
  const el = document.createElement('meta');
  el.setAttribute('name', name);
  el.setAttribute('content', content);
  document.head.appendChild(el);
  return () => el.remove();
}

function card(inner: string): string {
  return `<div class="pl pla pc"><div class="pc-wrap">
    <header class="pc-top"><a class="pc-brand" href="#/bonsai"><img src="/peal-logo.png" alt="" width="26" height="26"><span>Peal Private Links</span></a><span class="pc-top-r">Payment request</span></header>
    <div class="pc-card">${inner}</div>
    <p class="pc-foot">Private on the Peal ledger. Only deposits and withdrawals touch the chain.</p>
  </div></div>`;
}

function problem(title: string, body: string): string {
  return card(`<div class="pc-body"><h1 class="pc-h1">${title}</h1><p class="pla-p">${body}</p></div>`);
}

/** The addendum's progress labels, only the applicable ones. */
type Stage = 'idle' | 'approve' | 'funding' | 'preparing' | 'sent' | 'sent_queued';

interface PayState {
  request: PaymentRequest | null;
  manifestOk: boolean | null;
  /** The manifest's signing key matches the payee's directory profile. */
  profileOk: boolean | null;
  stage: Stage;
  error: string | null;
  busy: string | null;
  balance: string | null;
  position: number | null;
  intentId: string;
  walletTokenBalance: string | null;
  /** Estimated network fee for the funding leg, in wei, when funding is needed. */
  feeWei: string | null;
}

const REQUEST_ID = /^[a-z2-7]{24}$/;

/** The payer intent id for a request, kept for this tab so a reload keeps
 * its own reservation instead of seeing itself as another payer. */
function intentFor(requestId: string): string {
  const k = `peal-links:intent:${requestId}`;
  try {
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const fresh = newIntentId();
    sessionStorage.setItem(k, fresh);
    return fresh;
  } catch {
    return newIntentId();
  }
}

function paidMarker(requestId: string): number | null {
  try {
    const v = sessionStorage.getItem(`peal-links:paid:${requestId}`);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function markPaid(requestId: string, position: number): void {
  try {
    sessionStorage.setItem(`peal-links:paid:${requestId}`, String(position));
  } catch {
    /* storage unavailable */
  }
}

/** Funding in progress for this request: the deposit intent's receipt and
 * the transaction that carried it. Survives a reload so the page resumes
 * waiting for the credit instead of making a second deposit. It is written
 * only once the deposit is on chain; a rejected or failed send leaves no
 * marker, so the next attempt deposits again. */
interface Funding {
  receipt: string;
  tx: string;
}

function fundingMarker(requestId: string): Funding | null {
  try {
    const raw = sessionStorage.getItem(`peal-links:funding:${requestId}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Funding>;
    return v && typeof v.receipt === 'string' && typeof v.tx === 'string' ? { receipt: v.receipt, tx: v.tx } : null;
  } catch {
    return null;
  }
}

function setFundingMarker(requestId: string, f: Funding | null): void {
  try {
    if (f) sessionStorage.setItem(`peal-links:funding:${requestId}`, JSON.stringify(f));
    else sessionStorage.removeItem(`peal-links:funding:${requestId}`);
  } catch {
    /* storage unavailable */
  }
}

function stageList(stage: Stage, needsFunds: boolean): string {
  const steps: Array<[Stage, string, string]> = [
    ['approve', 'Approve payment', 'Your wallet confirms the amount and the recipient'],
    ...(needsFunds ? ([['funding', 'Adding funds', 'A public deposit from your wallet, credited after a few blocks']] as Array<[Stage, string, string]>) : []),
    ['preparing', 'Preparing payment', 'The proof is made in this browser, about seven seconds'],
    ['sent', 'Payment sent', 'The ledger accepted it; an encrypted receipt reaches the payee'],
  ];
  const order = steps.map(([st]) => st);
  const current = stage === 'sent_queued' ? 'sent' : stage;
  const idx = order.indexOf(current);
  return `<ol class="pla-timeline pl-steps">${steps
    .map(([st, label, text], i) => {
      const done = i < idx || current === 'sent';
      const now = st === current && current !== 'sent';
      const cls = done ? 'is-done pl-step-done' : now ? 'is-now pl-step-active' : 'is-todo';
      return `<li class="pl-step ${cls}"><span class="pla-tl-dot">${done ? icon('check') : now ? '<span class="pla-spinner pla-spinner-sm"></span>' : ''}</span><b>${label}</b><i>${text}</i></li>`;
    })
    .join('')}</ol>`;
}

function icon(name: 'check' | 'wallet' | 'ext'): string {
  const paths = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    wallet: '<path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/><path d="M18 13h-2a1 1 0 0 0 0 2h2a1 1 0 0 0 0-2z"/>',
    ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  };
  return `<svg class="pla-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function fmtEth(wei: string): string {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function html(s: PayState): string {
  const l = links();
  if (l.statusError) return problem('could not reach the network', 'The Peal Links node is not reachable. The request is not lost; try again once the stack is running.');
  if (!s.request || !l.status) return card(`<div class="pc-body"><div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div></div>`);
  const m = s.request.manifest;
  const ns = l.status.namespaces.find((n) => n.id === m.namespace);
  const amount = ns ? formatUnits(m.amount, ns.decimals) : m.amount;
  const symbol = ns ? ns.token_symbol : 'units';
  const expired = m.expires_at !== null && m.expires_at * 1000 < Date.now();
  const state = s.request.status === 'fulfilled' ? 'fulfilled' : s.request.status === 'archived' ? 'archived' : expired || s.request.status === 'expired' ? 'expired' : !ns ? 'unavailable' : 'payable';
  const evm = session();

  const paidHere = s.position ?? paidMarker(m.request_id);
  const stateLine = {
    payable:
      paidHere !== null
        ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>paid from this device · awaiting the payee's claim</span>`
        : s.request.reserved && s.stage === 'idle'
          ? `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>someone is completing this payment right now</span>`
          : `<span class="pl-status"><span class="pl-status-dot"></span>awaiting payment</span>`,
    expired: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>expired ${m.expires_at ? esc(fmtTime(m.expires_at)) : ''}</span>`,
    fulfilled: `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>paid · acknowledged by the receiver${s.request.fulfilled_at ? ` ${esc(fmtTime(s.request.fulfilled_at))}` : ''}</span>`,
    archived: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>this request was withdrawn by its creator</span>`,
    unavailable: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>the payment network for this request is not served by this node</span>`,
  }[state];

  const bad = s.manifestOk === false || s.profileOk === false;
  const verifiedLine = s.manifestOk === null ? 'checking…' : bad ? '' : 'verified on this device';
  const badNotice = !s.manifestOk && s.manifestOk !== null
    ? `<div class="pl-notice pl-notice-bad" role="alert">This request's signature does not verify. Do not pay.</div>`
    : s.profileOk === false
      ? `<div class="pl-notice pl-notice-bad" role="alert">The payee's wallet did not authorize this request. Do not pay.</div>`
      : '';

  const needsFunds = s.balance !== null && BigInt(s.balance) < BigInt(m.amount);
  const shortfall = needsFunds && ns ? BigInt(m.amount) - BigInt(s.balance!) : 0n;

  let action = '';
  if (state === 'payable' && s.manifestOk && paidHere === null && s.stage === 'idle' && s.request.reserved) {
    action = `<p class="pc-help">Another payer reserved this request a few minutes ago. If they do not complete it, the reservation expires and this page updates by itself.</p>`;
  } else if (state === 'payable' && s.manifestOk && paidHere !== null && s.stage === 'idle') {
    action = `<a class="pla-btn pla-btn-lg pla-btn-block" href="#/bonsai/app">Open my payments</a><p class="pc-help">This link was paid from this browser. Paying it again would send a second payment.</p>`;
  } else if (state === 'payable' && s.manifestOk && s.profileOk !== false) {
    if (s.stage === 'sent' || s.stage === 'sent_queued') {
      action = `
        <div class="pc-done"><span class="pc-done-ic">${icon('check')}</span><div><b>Payment sent.</b><span>${s.stage === 'sent' ? 'The encrypted receipt was delivered to the payee; they will see it when they are next online.' : 'The encrypted receipt could not be delivered yet; it is queued and will be retried. The payment itself is complete.'}</span></div></div>
        ${stageList(s.stage, needsFunds)}
        <a class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block" href="#/bonsai/app">Open my payments</a>`;
    } else if (s.stage !== 'idle') {
      action = `${busyBanner(s.busy ?? 'working')}${stageList(s.stage, needsFunds)}`;
    } else if (!evm.address) {
      action = `<button type="button" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block" id="pay-login-injected" aria-label="Use browser wallet" ${injectedProvider() ? '' : 'disabled'}>${icon('wallet')} Connect wallet to pay</button>
        <p class="pc-help">${injectedProvider() ? 'MetaMask, Rabby or another browser wallet.' : 'No browser wallet found. <a class="pla-link" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get MetaMask</a>, then reload.'}</p>`;
    } else if (!l.account) {
      if (l.setup === 'needs-recovery-code') {
        action = `<form id="pay-recovery-code" class="pla-form"><label class="pla-field"><span class="pla-label">Your recovery code</span><span class="pla-help">This wallet already has private payments on Peal; the code you saved opens its backup here.</span><input class="pla-input pl-mono" name="code" required autocomplete="off" placeholder="PEAL-XXXXX-XXXXX-XXXXX-XXXXX"></label><button type="submit" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block">Open my account and continue</button></form>`;
      } else if (l.setup !== 'idle' && l.setup !== 'no-backup') {
        action = busyBanner(l.setupDetail ?? 'working');
      } else {
        action = `${l.setupDetail ? `<div class="pl-notice pl-notice-warn">${esc(cap(l.setupDetail))}</div>` : ''}<button type="button" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block" id="pay-activate">Continue with wallet ${esc(shortHex(evm.address, 6, 4))}</button>
          <p class="pc-help">${l.hasStoredAccount ? 'No signature needed.' : 'Two wallet signatures the first time: an authorization and a recovery message.'}</p>`;
      }
    } else if (needsFunds && ns) {
      const unit = 10n ** BigInt(ns.decimals);
      const topUp = ((shortfall + unit - 1n) / unit) * unit; // whole units, as the flow adds them
      const short = formatUnits(shortfall.toString(), ns.decimals);
      const added = formatUnits(topUp.toString(), ns.decimals);
      const fundable = ns.available && s.walletTokenBalance !== null && BigInt(s.walletTokenBalance) >= topUp;
      action = fundable
        ? `<button type="button" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block" id="pay-now">Approve and pay ${esc(amount)} ${esc(symbol)}</button>
           <p class="pc-help">Adds ${esc(added)} ${esc(symbol)} from your wallet first (${esc(short)} ${esc(symbol)} short, whole units), then pays privately. Two wallet confirmations.</p>`
        : ns.available
          ? `<div class="pl-notice pl-notice-warn"><strong>Not enough funds.</strong> Your private balance is ${formatUnits(s.balance!, ns.decimals)} ${esc(symbol)} and your wallet holds ${s.walletTokenBalance !== null ? formatUnits(s.walletTokenBalance, ns.decimals) : '—'} ${esc(symbol)} on ${esc(ns.chain_name)}; this request needs ${esc(short)} ${esc(symbol)} more.</div>${(() => {
              const src = testFundsSource(ns);
              if (!src) return '';
              if (src.kind === 'external') return `<a class="pla-btn pla-btn-lg pla-btn-block" href="${esc(src.url)}" target="_blank" rel="noreferrer">${icon('ext')} Get testnet ${esc(symbol)}</a>`;
              return `<button type="button" class="pla-btn pla-btn-lg pla-btn-block" id="pay-test-funds">Get test ${esc(symbol)} for my wallet</button>`;
            })()}`
          : `<p class="pc-help">Deposits on ${esc(ns.chain_name)} are not available on this node.</p>`;
    } else {
      action = `<button type="button" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block" id="pay-now">Pay ${esc(amount)} ${esc(symbol)}</button>
        <p class="pc-help">Your wallet confirms, this browser proves it. About seven seconds.</p>`;
    }
  }

  const fee = needsFunds && ns
    ? `≈ ${s.feeWei ? `${esc(fmtEth(s.feeWei))} ${esc(gasSymbol(ns.chain_id))}` : 'estimating…'} network fee on ${esc(ns.chain_name)} to add funds · none on the private ledger`
    : 'none';

  const codeBanner = l.newRecoveryCode
    ? `<div class="pl-notice pl-notice-warn" role="alert"><strong>Save your recovery code now.</strong> Your wallet cannot derive a recovery key, so this code protects the backup of your private account. It is shown once and Peal never stores it.<div class="pl-share-link" style="margin-top:10px"><input class="pla-input pl-mono" readonly value="${esc(l.newRecoveryCode)}" id="pl-code"><button type="button" class="pla-btn" data-copy="${esc(l.newRecoveryCode)}">Copy</button></div><div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pla-btn pla-btn-dark" id="pl-code-saved">I saved it</button></div></div>`
    : '';

  const rows: Array<[string, string]> = [
    ['Asset', ns ? `${esc(ns.token_symbol)} · ${esc(ns.chain_name)}${ns.environment !== 'mainnet' ? ` · ${esc(ns.environment)} funds` : ''}` : 'unknown asset domain'],
    ...(needsFunds && ns ? ([['Fees', fee]] as Array<[string, string]>) : []),
    ...(m.reference ? ([['Reference', esc(m.reference)]] as Array<[string, string]>) : []),
    ...(m.expires_at ? ([['Expires', esc(fmtTime(m.expires_at))]] as Array<[string, string]>) : []),
    ...(evm.address
      ? ([
          [
            'Paying from',
            `<span class="pc-from">${avatar(evm.address, 18)}${connectorLine()}${s.stage === 'idle' && paidHere === null ? ` · <button type="button" class="pla-link pl-link-btn" id="pay-switch-wallet" title="disconnect this wallet and choose another">switch wallet</button>` : ''}</span>`,
          ],
        ] as Array<[string, string]>)
      : []),
  ];

  return card(`
    ${codeBanner ? `<div class="pc-body">${codeBanner}</div>` : ''}
    <div class="pc-head">
      <div class="pc-head-row">
        <div>
          <span class="pc-kicker">${esc(m.title)}</span>
          <div class="pc-amount">${esc(amount)}<span class="pc-unit">${esc(symbol)}</span></div>
        </div>
        <div class="pc-state">${stateLine}</div>
      </div>
      <div class="pl-payee pc-payee">
        ${avatar(m.receiver_address, 40)}
        <div class="pc-payee-text">
          <span class="pc-payee-to">to</span>
          <b class="pc-payee-name">${esc(m.display_name)}</b>
          <span class="pl-payee-assurance"><span class="pl-mono">${esc(shortHex(m.receiver_address, 6, 4))}</span>${verifiedLine ? ` · ${verifiedLine}` : ''}</span>
        </div>
      </div>
      ${badNotice ? `<div class="pc-bad">${badNotice}</div>` : ''}
    </div>
    <div class="pc-body">
      <dl class="pla-kv pc-kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    </div>
    ${s.error ? `<div class="pc-body pc-body-tight"><div class="pl-notice pl-notice-bad" role="alert">${esc(s.error)}</div></div>` : ''}
    ${l.paramsProgress && s.stage === 'idle' ? `<div class="pc-body pc-body-tight">${busyBanner(l.paramsProgress)}</div>` : ''}
    <div class="pc-actions">${action}</div>
  `);
}

export function renderPay(root: HTMLElement, requestId: string): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. payment request';
  const unmeta = [setMeta('robots', 'noindex, nofollow'), setMeta('referrer', 'no-referrer')];
  document.body.classList.add('pla-page');
  let stale = false;
  const s: PayState = { request: null, manifestOk: null, profileOk: null, stage: 'idle', error: null, busy: null, balance: null, position: null, intentId: intentFor(requestId), walletTokenBalance: null, feeWei: null };
  const cleanups: Array<() => void> = [];
  const nsOf = () => links().status?.namespaces.find((n) => n.id === s.request?.manifest.namespace) ?? null;
  /** The request decides the asset domain, not the node's namespace order.
   * The session boots on the first namespace it sees; a request for any
   * other one must move the session there BEFORE an account is unlocked or
   * created, or the payer ends up with an account on the wrong ledger and
   * every payment fails with "request is for another asset domain". Safe to
   * call repeatedly: a no-op when the session is already on the right one. */
  const syncNamespace = async () => {
    const ns = nsOf();
    if (ns && links().namespace?.id !== ns.id) await selectNamespace(ns);
  };
  const paint = () => {
    if (stale) return;
    const active = document.activeElement as HTMLInputElement | null;
    const v = active?.value;
    const n = active?.name;
    root.innerHTML = html(s);
    if (n) {
      const again = root.querySelector<HTMLInputElement>(`input[name="${n}"]`);
      if (again && v !== undefined) {
        again.value = v;
        again.focus();
      }
    }
  };

  if (!REQUEST_ID.test(requestId)) {
    root.innerHTML = problem('not a payment link', 'This address does not name a payment request. Check the link you were sent.');
    return () => {
      for (const f of unmeta) f();
      document.body.classList.remove('pla-page');
      document.title = previousTitle;
    };
  }
  paint();

  const refreshBalance = async () => {
    const l = links();
    if (!l.account) {
      s.balance = null;
      return;
    }
    const v = await l.account.view();
    s.balance = v.balance;
    if (v.pending) {
      await l.account.reconcile();
      s.balance = (await l.account.view()).balance;
    }
  };

  const refreshWalletBalance = async () => {
    const evm = session();
    const ns = nsOf();
    if (!ns || !evm.address || !evm.provider || !ns.available) {
      s.walletTokenBalance = null;
      return;
    }
    try {
      s.walletTokenBalance = (await tokenBalance(ns, evm.address as Address, evm.provider as unknown as EIP1193Provider)).toString();
      const pc = publicClientFor(ns, evm.provider as unknown as EIP1193Provider);
      const gasPrice = await pc.getGasPrice();
      // approve (about 50k gas) plus deposit (about 90k): an estimate shown
      // before any authorization, labelled as such.
      s.feeWei = (gasPrice * (ns.chain_id === 42431 ? 400_000n : 150_000n)).toString();
    } catch {
      s.walletTokenBalance = null;
    }
  };

  /** Once signed in, check the manifest's signing key against the payee's
   * directory profile. Not signed in: the wasm signature check stands alone. */
  const checkProfile = async () => {
    const l = links();
    if (!s.request || !l.signedIn || s.profileOk !== null) return;
    try {
      const entry = await client.profile(s.request.manifest.namespace, s.request.manifest.receiver_address);
      s.profileOk = !!entry && entry.profile.profile_key === s.request.manifest.signer_pubkey && entry.profile.account === s.request.manifest.receiver_account && !entry.profile.revoked;
    } catch {
      /* rate limited or offline: leave undecided */
    }
  };

  const run = async (label: string, stage: Stage | null, f: () => Promise<void>) => {
    s.busy = label;
    s.error = null;
    if (stage) s.stage = stage;
    paint();
    try {
      await f();
    } catch (e) {
      const ns = nsOf();
      s.error = e instanceof LinksApiError && e.code === 'reserved' ? 'Someone else is completing this payment right now. Try again in a few minutes.' : describeError(e, ns?.chain_name, ns?.chain_id);
      if (s.stage !== 'sent' && s.stage !== 'sent_queued') s.stage = 'idle';
    } finally {
      s.busy = null;
      await refreshBalance().catch(() => {});
      paint();
    }
  };

  /** The whole flow: approve (a local wallet intent), add funds if the
   * private balance is short, prepare (prove and submit), sent. */
  const pay = async (account: LinksAccount) => {
    const req = await client.getRequest(requestId, s.intentId);
    s.request = req;
    const ns = nsOf()!;
    if (account.namespace !== ns.id) {
      // An account unlocked for another domain: drop it so the page offers
      // to set up (or unlock) the one this request is for.
      await syncNamespace();
      throw new Error(`this request is paid on ${ns.chain_name}; set up private payments for that ledger to continue`);
    }
    const evm = session();
    if (!evm.address || !evm.provider) throw new Error('connect a wallet first');
    await run('confirm the payment in your wallet', 'approve', async () => {
      await ensureWalletChain(ns);
      const signer = providerSigner(evm.provider!, evm.address!, ns.chain_id);
      const intent = await account.paymentIntentFor({ request: req });
      const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
      // Funding leg, only when needed; resumes a deposit that is already on
      // chain (marker) instead of making a second one.
      let balance = (await account.view()).balance;
      if (BigInt(balance) < BigInt(req.manifest.amount)) {
        s.stage = 'funding';
        // A deposit already on chain from an earlier attempt or before a
        // reload is resumed, but only after the chain confirms it exists
        // and succeeded; anything else starts a fresh deposit.
        let marker = fundingMarker(requestId);
        if (marker) {
          const pc = publicClientFor(ns, evm.provider as unknown as EIP1193Provider);
          const rc = await pc.getTransactionReceipt({ hash: marker.tx as `0x${string}` }).catch(() => null);
          if (!rc || rc.status !== 'success') {
            setFundingMarker(requestId, null);
            marker = null;
          }
        }
        let receipt: string;
        if (marker) {
          receipt = marker.receipt;
        } else {
          const unit = 10n ** BigInt(ns.decimals);
          const need = BigInt(req.manifest.amount) - BigInt(balance);
          const topUp = ((need + unit - 1n) / unit) * unit; // whole units, so the balance reads cleanly
          s.busy = 'adding funds: proving the deposit intent';
          paint();
          const prepared = await account.prepareDeposit(topUp.toString(), `for link ${requestId.slice(0, 8)}`);
          receipt = prepared.receipt;
          s.busy = 'adding funds: confirm the approval and the deposit in your wallet';
          paint();
          await ensureGas(ns, evm.address as Address);
          const tx = await depositOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, topUp, receipt);
          setFundingMarker(requestId, { receipt, tx: tx.depositHash });
        }
        s.busy = `adding funds: deposit is on ${ns.chain_name}, waiting for ${ns.confirmations} confirmation${ns.confirmations === 1 ? '' : 's'} and the ledger credit (this can take minutes on slower chains)`;
        paint();
        let credited = false;
        for (let i = 0; i < 300 && !stale; i++) {
          if ((await account.syncDeposits()).length) {
            credited = true;
            break;
          }
          const v = await account.view();
          if (v.receipts.some((r) => r.receipt === receipt)) {
            credited = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!credited) throw new Error('the deposit was not credited in time; it will appear under incoming on your payments page, and this link can be paid then');
        await account.verifyReceipts();
        const v = await account.view();
        const idx = v.receipts.findIndex((r) => r.receipt === receipt && r.status === 'unclaimed');
        if (idx >= 0) {
          s.busy = 'adding funds: claiming the deposit (proving on this device, about 7 s)';
          paint();
          await account.claim(idx);
        }
        setFundingMarker(requestId, null);
        balance = (await account.view()).balance;
        if (BigInt(balance) < BigInt(req.manifest.amount)) throw new Error('funds were added but the balance is still short; try again');
      }
      s.stage = 'preparing';
      s.busy = 'preparing the payment: proving on this device (about 7 s)';
      paint();
      const res = await account.pay({ request: req }, s.intentId, { intent, signature });
      s.position = res.position;
      markPaid(requestId, res.position);
      s.stage = res.delivered ? 'sent' : 'sent_queued';
    });
  };

  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const data = new FormData(form);
    if (form.id === 'pay-recovery-code') void run('opening your account with the recovery code', null, async () => void (await recoverWithCode(String(data.get('code') ?? ''))));
  });

  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn) return;
    const l = links();
    if (btn.id === 'pay-now' && l.account) void pay(l.account);
    else if (btn.id === 'pay-login') session().login();
    else if (btn.id === 'pay-login-injected') void connectInjected().then(refreshWalletBalance).then(paint).catch((e) => { s.error = describeError(e); paint(); });
    else if (btn.id === 'pay-switch-wallet') {
      disconnect();
      s.error = null;
      s.balance = null;
      s.walletTokenBalance = null;
      paint();
    }
    else if (btn.id === 'pay-activate') void run('setting up private payments for your wallet', null, async () => { await syncNamespace(); await activate(); });
    else if (btn.id === 'pay-test-funds') {
      const ns = nsOf()!;
      const evm = session();
      void run(`getting test ${ns.token_symbol} for your wallet`, null, async () => {
        await ensureWalletChain(ns);
        await claimTestFunds(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address);
        await refreshWalletBalance();
      });
    }
    else if (btn.id === 'pl-code-saved') {
      acknowledgeRecoveryCode();
      paint();
    } else if (btn.dataset.copy) void navigator.clipboard?.writeText(btn.dataset.copy);
  });

  const unsub = onLinksChange(() => {
    void refreshBalance()
      .then(checkProfile)
      .then(paint)
      .catch(() => paint());
  });
  const unsubAuth = onAuthChange(() => {
    void refreshWalletBalance().then(paint);
  });

  void (async () => {
    await loadStatus();
    await resumeSignIn();
    await resumeInjected();
    try {
      s.request = await client.getRequest(requestId, s.intentId);
    } catch (e) {
      if (stale) return;
      if (e instanceof LinksApiError && e.status === 404) root.innerHTML = problem('request not found', 'The Peal Links node does not know this request. It may have been created on another deployment, or the local stack was reset.');
      else if (e instanceof LinksApiError && e.status === 0) root.innerHTML = problem('could not reach the network', 'The Peal Links node is not reachable. The request is not lost; try again once the stack is running.');
      else root.innerHTML = problem('something went wrong', esc(e instanceof Error ? e.message : String(e)));
      return;
    }
    await syncNamespace();
    paint();
    // Verify the manifest in wasm before showing a pay button. This loads
    // the worker but not the proving keys.
    try {
      const { getProver } = await import('../links/session');
      await getProver().verifyRequest(JSON.stringify(s.request.manifest));
      s.manifestOk = true;
    } catch {
      s.manifestOk = false;
    }
    await checkProfile();
    await refreshWalletBalance();
    // A signed-in wallet with an account on this device continues by itself
    // (an unlock, no prompt), so a reload mid-checkout resumes where it was.
    const l = links();
    const evm = session();
    if (!l.account && l.hasStoredAccount && l.signedIn && evm.address && l.signedIn.toLowerCase() === evm.address.toLowerCase()) {
      await activate().catch(() => {});
    }
    await refreshBalance().catch(() => {});
    paint();
    // Keep the request's status current while the page is open.
    const timer = window.setInterval(async () => {
      if (stale) return;
      try {
        const fresh = await client.getRequest(requestId, s.intentId);
        if (fresh.status !== s.request?.status || fresh.reserved !== s.request?.reserved) {
          s.request = fresh;
          paint();
        }
      } catch {
        /* next tick */
      }
    }, 5000);
    cleanups.push(() => window.clearInterval(timer));
  })();

  return () => {
    stale = true;
    unsub();
    unsubAuth();
    for (const f of cleanups) f();
    for (const f of unmeta) f();
    document.body.classList.remove('pla-page');
    document.title = previousTitle;
  };
}

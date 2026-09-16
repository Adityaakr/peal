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
import { acknowledgeRecoveryCode, activate, client, links, loadStatus, onLinksChange, recoverWithCode, resumeSignIn } from '../links/session';
import '../links.css';

function setMeta(name: string, content: string): () => void {
  const el = document.createElement('meta');
  el.setAttribute('name', name);
  el.setAttribute('content', content);
  document.head.appendChild(el);
  return () => el.remove();
}

function card(inner: string): string {
  return `<div class="pl"><div class="pl-checkout"><div class="pl-checkout-card">${inner}</div><p class="pl-checkout-foot">Peal Links · a payment request, paid privately on the Bonsai ledger. Deposits and withdrawals are public on the backing chain; the payment is not.</p></div></div>`;
}

function problem(title: string, body: string): string {
  return card(`<span class="pl-product-label">Peal Links</span><h1 class="pl-dialog-title">${title}</h1><p class="pl-p">${body}</p>`);
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '·'
  );
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

/** Funding in progress for this request: survives a reload so the page
 * resumes waiting for the credit instead of starting a second deposit. */
function fundingMarker(requestId: string): string | null {
  try {
    return sessionStorage.getItem(`peal-links:funding:${requestId}`);
  } catch {
    return null;
  }
}

function setFundingMarker(requestId: string, receipt: string | null): void {
  try {
    if (receipt) sessionStorage.setItem(`peal-links:funding:${requestId}`, receipt);
    else sessionStorage.removeItem(`peal-links:funding:${requestId}`);
  } catch {
    /* storage unavailable */
  }
}

function stageList(stage: Stage, needsFunds: boolean): string {
  const steps: Array<[Stage, string]> = [
    ['approve', 'Approve payment'],
    ...(needsFunds ? ([['funding', 'Adding funds']] as Array<[Stage, string]>) : []),
    ['preparing', 'Preparing payment'],
    ['sent', 'Payment sent'],
  ];
  const order = steps.map(([s]) => s);
  const current = stage === 'sent_queued' ? 'sent' : stage;
  const idx = order.indexOf(current);
  return `<ul class="pl-steps">${steps
    .map(([s, label], i) => {
      const cls = i < idx || current === 'sent' ? 'pl-step-done' : s === current ? 'pl-step-active' : '';
      return `<li class="pl-step ${cls}">${label}</li>`;
    })
    .join('')}</ul>`;
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
  if (!s.request || !l.status) return card(`<span class="pl-product-label">Peal Links</span><div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div>`);
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

  const manifestLine =
    s.manifestOk === null
      ? `<span class="pl-small">checking signature…</span>`
      : !s.manifestOk
        ? `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>signature does not verify: do not pay</span>`
        : s.profileOk === false
          ? `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>the payee's wallet did not authorize this request's key: do not pay</span>`
          : s.profileOk
            ? `<span class="pl-small">signed by the payee's account · wallet authorization verified on this device</span>`
            : `<span class="pl-small">signed by the payee's account · verified on this device</span>`;

  const needsFunds = s.balance !== null && BigInt(s.balance) < BigInt(m.amount);
  const shortfall = needsFunds && ns ? BigInt(m.amount) - BigInt(s.balance!) : 0n;

  let action = '';
  if (state === 'payable' && s.manifestOk && paidHere === null && s.stage === 'idle' && s.request.reserved) {
    action = `<p class="pl-small" style="text-align:center;margin:0">Another payer reserved this request a few minutes ago. If they do not complete it, the reservation expires and this page updates by itself.</p>`;
  } else if (state === 'payable' && s.manifestOk && paidHere !== null && s.stage === 'idle') {
    action = `<a class="pl-btn pl-btn-block" href="#/bonsai/app">Open my payments</a><p class="pl-small" style="text-align:center;margin:0">This link was paid from this browser. Paying it again would send a second payment.</p>`;
  } else if (state === 'payable' && s.manifestOk && s.profileOk !== false) {
    if (s.stage === 'sent' || s.stage === 'sent_queued') {
      action = `
        <div class="pl-notice" role="status"><strong>Payment sent.</strong> ${s.stage === 'sent' ? 'The encrypted receipt was delivered to the payee; they will see it when they are next online.' : 'The encrypted receipt could not be delivered yet; it is queued and will be retried. The payment itself is complete.'}</div>
        ${stageList(s.stage, needsFunds)}
        <a class="pl-btn pl-btn-block" href="#/bonsai/app">Open my payments</a>`;
    } else if (s.stage !== 'idle') {
      action = `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(s.busy ?? 'working')}</span></div>${stageList(s.stage, needsFunds)}`;
    } else if (!evm.address) {
      action = `<div class="pl-actions" style="margin:0"><button type="button" class="pl-btn pl-btn-primary" id="pay-login">Connect wallet</button>${injectedProvider() ? `<button type="button" class="pl-btn" id="pay-login-injected">Use browser wallet</button>` : ''}</div>
        <p class="pl-small" style="margin:8px 0 0">Your existing wallet is all you need. Peal keeps a private account behind it; the payment hides the amount and the parties.</p>`;
    } else if (!l.account) {
      if (l.setup === 'needs-recovery-code') {
        action = `<form id="pay-recovery-code"><label class="pl-field"><span class="pl-label">your Peal Links recovery code</span><input class="pl-input pl-mono" name="code" required autocomplete="off" placeholder="PEAL-XXXXX-XXXXX-XXXXX-XXXXX"></label><button type="submit" class="pl-btn pl-btn-primary pl-btn-block">Open my account and continue</button></form>`;
      } else if (l.setup !== 'idle' && l.setup !== 'no-backup') {
        action = `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(l.setupDetail ?? 'working')}</span></div>`;
      } else {
        action = `${l.setupDetail ? `<div class="pl-notice pl-notice-warn">${esc(l.setupDetail)}</div>` : ''}<button type="button" class="pl-btn pl-btn-primary pl-btn-block" id="pay-activate">Continue with wallet ${esc(shortHex(evm.address, 6, 4))}</button>
          <p class="pl-small" style="text-align:center;margin:8px 0 0">${l.hasStoredAccount ? 'Unlocks your private account on this device; no signature needed.' : 'First time: your wallet confirms one Peal Links authorization and one recovery message.'}</p>`;
      }
    } else if (needsFunds && ns) {
      const unit = 10n ** BigInt(ns.decimals);
      const topUp = ((shortfall + unit - 1n) / unit) * unit; // whole units, as the flow adds them
      const short = formatUnits(shortfall.toString(), ns.decimals);
      const added = formatUnits(topUp.toString(), ns.decimals);
      const fundable = ns.available && s.walletTokenBalance !== null && BigInt(s.walletTokenBalance) >= topUp;
      action = fundable
        ? `<button type="button" class="pl-btn pl-btn-primary pl-btn-block" id="pay-now">Approve and pay ${esc(amount)} ${esc(symbol)}</button>
           <p class="pl-small" style="text-align:center;margin:8px 0 0">Adds ${esc(added)} ${esc(symbol)} from your wallet to your private balance first (the ${esc(short)} ${esc(symbol)} missing, rounded up to a whole unit) (two wallet confirmations, public on ${esc(ns.chain_name)}; credited after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}, which can take a few minutes on slower chains), then pays privately.</p>`
        : ns.available
          ? `<div class="pl-notice pl-notice-warn"><strong>Not enough funds.</strong> Your private balance is ${formatUnits(s.balance!, ns.decimals)} ${esc(symbol)} and your wallet holds ${s.walletTokenBalance !== null ? formatUnits(s.walletTokenBalance, ns.decimals) : '—'} ${esc(symbol)} on ${esc(ns.chain_name)}; this request needs ${esc(short)} ${esc(symbol)} more.</div>${(() => {
              const src = testFundsSource(ns);
              if (!src) return '';
              if (src.kind === 'external') return `<a class="pl-btn pl-btn-block" href="${esc(src.url)}" target="_blank" rel="noreferrer">Get testnet ${esc(symbol)}</a>`;
              return `<button type="button" class="pl-btn pl-btn-block" id="pay-test-funds">Get test ${esc(symbol)} for my wallet</button>`;
            })()}`
          : `<div class="pl-small" style="text-align:center">Deposits on ${esc(ns.chain_name)} are not available on this node.</div>`;
    } else {
      action = `<button type="button" class="pl-btn pl-btn-primary pl-btn-block" id="pay-now">Pay ${esc(amount)} ${esc(symbol)}</button>
        <p class="pl-small" style="text-align:center;margin:0">Your wallet confirms the payment; proving takes about seven seconds on this device. Nothing leaves your browser except the proof and an encrypted receipt.</p>`;
    }
  }

  const feeRow = needsFunds && ns
    ? `<div class="pl-row"><span class="pl-row-label">fees</span><span class="pl-row-value">none on the private ledger · funding leg ≈ ${s.feeWei ? `${esc(fmtEth(s.feeWei))} ${esc(gasSymbol(ns.chain_id))}` : 'estimating…'} network fee on ${esc(ns.chain_name)} (approve + deposit)</span></div>`
    : `<div class="pl-row"><span class="pl-row-label">fees</span><span class="pl-row-value">none on the private ledger</span></div>`;

  const codeBanner = l.newRecoveryCode
    ? `<div class="pl-notice pl-notice-warn" role="alert" style="margin-bottom:12px"><strong>Save your recovery code now.</strong> Your wallet cannot derive a recovery key, so this code protects the backup of your private account. It is shown once and Peal never stores it.<div class="pl-share-link" style="margin-top:10px"><input class="pl-input pl-mono" readonly value="${esc(l.newRecoveryCode)}" id="pl-code"><button type="button" class="pl-btn" data-copy="${esc(l.newRecoveryCode)}">Copy</button></div><div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pl-btn pl-btn-primary" id="pl-code-saved">I saved it</button></div></div>`
    : '';

  return card(`
    <span class="pl-product-label">Peal Links</span>
    ${codeBanner}
    <div class="pl-payee">
      <div class="pl-avatar" aria-hidden="true">${esc(initials(m.display_name))}</div>
      <div>
        <div class="pl-payee-name">${esc(m.display_name)}</div>
        <div class="pl-payee-assurance">wallet <span class="pl-mono">${esc(shortHex(m.receiver_address, 6, 4))}</span> · the name is chosen by the payee, the address is the verified part</div>
      </div>
    </div>
    <p class="pl-checkout-title">${esc(m.title)}</p>
    <div class="pl-amount">${esc(amount)}<span class="pl-amount-unit">${esc(symbol)}</span></div>
    <div class="pl-preview-rows">
      <div class="pl-row"><span class="pl-row-label">route</span><span class="pl-row-value">${ns ? `private payment on the Peal ledger · ${esc(ns.token_symbol)} from ${esc(ns.chain_name)}${ns.environment !== 'mainnet' ? ` · ${esc(ns.environment)} funds` : ''}` : 'unknown asset domain'}</span></div>
      ${feeRow}
      ${m.reference ? `<div class="pl-row"><span class="pl-row-label">reference</span><span class="pl-row-value">${esc(m.reference)}</span></div>` : ''}
      <div class="pl-row"><span class="pl-row-label">created</span><span class="pl-row-value">${esc(fmtTime(m.created_at))}</span></div>
      ${m.expires_at ? `<div class="pl-row"><span class="pl-row-label">expires</span><span class="pl-row-value">${esc(fmtTime(m.expires_at))}</span></div>` : ''}
      <div class="pl-row"><span class="pl-row-label">request</span><span class="pl-row-value">${manifestLine}</span></div>
    </div>
    <div>${stateLine}</div>
    ${s.error ? `<div class="pl-notice pl-notice-bad" role="alert" style="margin-top:12px">${esc(s.error)}</div>` : ''}
    ${l.paramsProgress ? `<div class="pl-notice" role="status" style="margin-top:12px"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(l.paramsProgress)}</span></div>` : ''}
    <div class="pl-checkout-actions">${action}</div>
  `);
}

export function renderPay(root: HTMLElement, requestId: string): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. payment request';
  const unmeta = [setMeta('robots', 'noindex, nofollow'), setMeta('referrer', 'no-referrer')];
  let stale = false;
  const s: PayState = { request: null, manifestOk: null, profileOk: null, stage: 'idle', error: null, busy: null, balance: null, position: null, intentId: intentFor(requestId), walletTokenBalance: null, feeWei: null };
  const cleanups: Array<() => void> = [];
  const nsOf = () => links().status?.namespaces.find((n) => n.id === s.request?.manifest.namespace) ?? null;
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
    const evm = session();
    if (!evm.address || !evm.provider) throw new Error('connect a wallet first');
    await run('confirm the payment in your wallet', 'approve', async () => {
      const signer = providerSigner(evm.provider!, evm.address!, ns.chain_id);
      const intent = await account.paymentIntentFor({ request: req });
      const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
      // Funding leg, only when needed; resumes a deposit that is already on
      // chain (marker) instead of making a second one.
      let balance = (await account.view()).balance;
      if (BigInt(balance) < BigInt(req.manifest.amount)) {
        s.stage = 'funding';
        let receipt = fundingMarker(requestId);
        if (!receipt) {
          const unit = 10n ** BigInt(ns.decimals);
          const need = BigInt(req.manifest.amount) - BigInt(balance);
          const topUp = ((need + unit - 1n) / unit) * unit; // whole units, so the balance reads cleanly
          s.busy = 'adding funds: proving the deposit intent';
          paint();
          const prepared = await account.prepareDeposit(topUp.toString(), `for link ${requestId.slice(0, 8)}`);
          receipt = prepared.receipt;
          setFundingMarker(requestId, receipt);
          s.busy = 'adding funds: confirm the approval and the deposit in your wallet';
          paint();
          await ensureGas(ns, evm.address as Address);
          await depositOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, topUp, receipt);
        }
        s.busy = `adding funds: waiting for ${ns.confirmations} confirmation${ns.confirmations === 1 ? '' : 's'} on ${ns.chain_name} and the ledger credit (this can take minutes on slower chains)`;
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
    else if (btn.id === 'pay-activate') void run('setting up private payments for your wallet', null, async () => void (await activate()));
    else if (btn.id === 'pay-test-funds') {
      const ns = nsOf()!;
      const evm = session();
      void run(`getting test ${ns.token_symbol} for your wallet`, null, async () => {
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
    document.title = previousTitle;
  };
}

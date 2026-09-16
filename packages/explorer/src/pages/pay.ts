// Peal Links: public checkout (#/pay/:requestId).
//
// Readable without a wallet. The manifest's signature is verified in the
// payer's own wasm before the amount is trusted; the display name is shown
// as what it is (self-chosen). Paying needs a private account with enough
// balance: a first-time payer sets one up right here, and funds it, and the
// page says so instead of hiding the dependency. Every terminal state is
// its own honest screen.
import type { LinksAccount, PaymentRequest } from 'peal-links';
import { LinksApiError, newIntentId } from 'peal-links';
import { esc } from '../util';
import { formatUnits, fmtTime, shortHex } from '../links/format';
import { client, createAccount, links, loadStatus, onLinksChange, openAccount } from '../links/session';
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

type Stage = 'idle' | 'setup' | 'funding' | 'preparing' | 'proving' | 'submitted' | 'accepted' | 'delivered' | 'delivery_pending' | 'rejected';

interface PayState {
  request: PaymentRequest | null;
  manifestOk: boolean | null;
  stage: Stage;
  error: string | null;
  busy: string | null;
  balance: string | null;
  position: number | null;
  intentId: string;
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

function stageList(stage: Stage): string {
  const steps: Array<[Stage[], string]> = [
    [['preparing'], 'checking the signed request and reserving it'],
    [['proving'], 'proving the payment on this device (about 7 s)'],
    [['submitted'], 'submitting to the ledger'],
    [['accepted'], 'accepted by the ledger'],
    [['delivered', 'delivery_pending'], 'delivering the encrypted receipt'],
  ];
  const order: Stage[] = ['preparing', 'proving', 'submitted', 'accepted', 'delivered'];
  const idx = order.indexOf(stage === 'delivery_pending' ? 'delivered' : stage);
  return `<ul class="pl-steps">${steps
    .map(([ss, label], i) => {
      const cls = i < idx || stage === 'delivered' ? 'pl-step-done' : ss.includes(stage) ? 'pl-step-active' : '';
      return `<li class="pl-step ${cls}">${label}</li>`;
    })
    .join('')}</ul>`;
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

  const paidHere = s.position ?? paidMarker(m.request_id);
  const stateLine = {
    payable:
      paidHere !== null
        ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>paid from this device · receipt #${paidHere} · awaiting the payee's claim</span>`
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
      : s.manifestOk
        ? `<span class="pl-small">signed by the payee's account · verified on this device</span>`
        : `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>signature does not verify: do not pay</span>`;

  let action = '';
  if (state === 'payable' && s.manifestOk && paidHere !== null && s.stage === 'idle') {
    action = `<a class="pl-btn pl-btn-block" href="#/bonsai/app">Open my payments</a><p class="pl-small" style="text-align:center;margin:0">This link was paid from this browser. Paying it again would send a second payment.</p>`;
  } else if (state === 'payable' && s.manifestOk) {
    if (s.stage === 'delivered' || s.stage === 'delivery_pending' || s.stage === 'accepted') {
      action = `
        <div class="pl-notice" role="status"><strong>Payment accepted by the ledger.</strong> Receipt #${s.position}. ${s.stage === 'delivered' ? 'The encrypted receipt was delivered to the payee; they will see it when they are next online.' : 'The encrypted receipt could not be delivered yet; it is queued and will be retried. The payment itself is complete.'}</div>
        ${stageList(s.stage)}
        <a class="pl-btn pl-btn-block" href="#/bonsai/app">Open my payments</a>`;
    } else if (s.stage === 'preparing' || s.stage === 'proving' || s.stage === 'submitted') {
      action = `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(s.busy ?? 'working')}</span></div>${stageList(s.stage)}`;
    } else if (!l.account) {
      action = l.hasStoredAccount
        ? `<form id="pay-unlock"><label class="pl-field"><span class="pl-label">unlock your private account to pay</span><input class="pl-input" type="password" name="pass" required minlength="10" autocomplete="current-password"></label><button type="submit" class="pl-btn pl-btn-primary pl-btn-block">Unlock and continue</button></form>`
        : `<div class="pl-notice">Paying needs a private account on the ledger. It is created here in your browser and protected by a passphrase; <strong>export a backup afterwards</strong>, because a lost browser storage cannot be recovered by a wallet connection. Then it needs funds.</div>
           <form id="pay-create"><label class="pl-field"><span class="pl-label">passphrase (at least 10 characters)</span><input class="pl-input" type="password" name="pass" required minlength="10" autocomplete="new-password"></label><button type="submit" class="pl-btn pl-btn-primary pl-btn-block">Create private account and continue</button></form>
           <p class="pl-small" style="text-align:center;margin:8px 0 0">Already have one? <a href="#/bonsai/app">Restore it from your backup</a>, then come back to this link.</p>`;
    } else if (s.balance !== null && BigInt(s.balance) < BigInt(m.amount)) {
      const short = ns ? formatUnits((BigInt(m.amount) - BigInt(s.balance)).toString(), ns.decimals) : '';
      action = `
        <div class="pl-notice pl-notice-warn"><strong>Not enough balance.</strong> Available ${ns ? formatUnits(s.balance, ns.decimals) : s.balance} ${esc(symbol)}; this request needs ${short} ${esc(symbol)} more.</div>
        ${
          ns?.available
            ? `<button type="button" class="pl-btn pl-btn-primary pl-btn-block" id="pay-fund">Add funds</button>`
            : l.status.dev_mint
              ? `<button type="button" class="pl-btn pl-btn-block" id="pay-dev-mint" title="development fixture">Add test funds (dev mint) and continue</button>`
              : `<div class="pl-small" style="text-align:center">Deposits on ${esc(ns?.chain_name ?? 'this chain')} arrive with the chain gateway (Phase D).</div>`
        }`;
    } else {
      action = `<button type="button" class="pl-btn pl-btn-primary pl-btn-block" id="pay-now">Pay ${esc(amount)} ${esc(symbol)}</button>
        <p class="pl-small" style="text-align:center;margin:0">Proving takes about seven seconds on this device. Nothing leaves your browser except the proof and an encrypted receipt.</p>`;
    }
  }

  return card(`
    <span class="pl-product-label">Peal Links</span>
    <div class="pl-payee">
      <div class="pl-avatar" aria-hidden="true">${esc(initials(m.display_name))}</div>
      <div>
        <div class="pl-payee-name">${esc(m.display_name)}</div>
        <div class="pl-payee-assurance">display name chosen by the payee · account <span class="pl-mono">${esc(shortHex(m.receiver_account, 8, 6))}</span></div>
      </div>
    </div>
    <p class="pl-checkout-title">${esc(m.title)}</p>
    <div class="pl-amount">${esc(amount)}<span class="pl-amount-unit">${esc(symbol)}</span></div>
    <div class="pl-preview-rows">
      <div class="pl-row"><span class="pl-row-label">network</span><span class="pl-row-value">${ns ? `${esc(ns.chain_name)}${ns.environment !== 'mainnet' ? ` · ${esc(ns.environment)} funds` : ''}` : 'unknown asset domain'}</span></div>
      <div class="pl-row"><span class="pl-row-label">fee</span><span class="pl-row-value">none on the private ledger</span></div>
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
  const s: PayState = { request: null, manifestOk: null, stage: 'idle', error: null, busy: null, balance: null, position: null, intentId: intentFor(requestId) };
  const cleanups: Array<() => void> = [];
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

  const run = async (label: string, stage: Stage | null, f: () => Promise<void>) => {
    s.busy = label;
    s.error = null;
    if (stage) s.stage = stage;
    paint();
    try {
      await f();
    } catch (e) {
      s.error = e instanceof LinksApiError && e.code === 'reserved' ? 'Someone else is completing this payment right now. Try again in a few minutes.' : e instanceof Error ? e.message : String(e);
      if (s.stage !== 'accepted' && s.stage !== 'delivered' && s.stage !== 'delivery_pending') s.stage = 'idle';
    } finally {
      s.busy = null;
      await refreshBalance().catch(() => {});
      paint();
    }
  };

  const pay = async (account: LinksAccount) => {
    const req = await client.getRequest(requestId);
    s.request = req;
    await run('checking the request and reserving it', 'preparing', async () => {
      // The SDK verifies the manifest, reserves, proves, submits, delivers.
      s.stage = 'proving';
      s.busy = 'proving the payment on this device';
      paint();
      const res = await account.pay(req, s.intentId);
      s.position = res.position;
      markPaid(requestId, res.position);
      s.stage = res.delivered ? 'delivered' : 'delivery_pending';
    });
  };

  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const pass = String(new FormData(form).get('pass') ?? '');
    if (form.id === 'pay-unlock') void run('unlocking', null, async () => void (await openAccount(pass)));
    else if (form.id === 'pay-create') void run('creating your private account and registering it', null, async () => void (await createAccount(pass)));
  });

  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn) return;
    const l = links();
    if (btn.id === 'pay-now' && l.account) void pay(l.account);
    else if (btn.id === 'pay-dev-mint' && l.account && s.request) {
      const account = l.account;
      const m = s.request.manifest;
      void run('crediting test funds and claiming them (two proofs, about 8 s)', null, async () => {
        const need = BigInt(m.amount) - BigInt(s.balance ?? '0');
        const ns = l.status!.namespaces.find((n) => n.id === m.namespace)!;
        // Round up to a whole unit so the balance reads cleanly.
        const unit = 10n ** BigInt(ns.decimals);
        const amount = ((need + unit - 1n) / unit) * unit;
        const { receipt } = await account.prepareDeposit(amount.toString(), 'test funds (dev mint)');
        await client.devMint(m.namespace, receipt);
        await account.sync();
        const v = await account.view();
        const idx = v.receipts.findIndex((r) => r.receipt === receipt && r.status === 'unclaimed');
        if (idx >= 0) await account.claim(idx);
      });
    } else if (btn.id === 'pay-fund') {
      s.error = 'On-chain funding arrives with the chain gateway (Phase D).';
      paint();
    }
  });

  const unsub = onLinksChange(() => {
    void refreshBalance().then(paint);
  });

  void (async () => {
    await loadStatus();
    try {
      s.request = await client.getRequest(requestId);
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
    await refreshBalance().catch(() => {});
    paint();
    // Keep the request's status current while the page is open.
    const timer = window.setInterval(async () => {
      if (stale) return;
      try {
        const fresh = await client.getRequest(requestId);
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
    for (const f of cleanups) f();
    for (const f of unmeta) f();
    document.title = previousTitle;
  };
}

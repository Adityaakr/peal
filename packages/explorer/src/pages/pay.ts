// Peal Links: public checkout (#/pay/:requestId).
//
// Readable without a wallet. The manifest's signature is verified in the
// payer's own wasm before the amount is trusted; the display name is shown
// as what it is (self-chosen). Paying needs a private account with enough
// balance: a first-time payer sets one up right here, and funds it, and the
// page says so instead of hiding the dependency. Every terminal state is
// its own honest screen.
import type { LinksAccount, PaymentRequest } from 'peal-links';
import { depositOnChain, LinksApiError, newIntentId, tokenBalance } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, injectedProvider, onAuthChange, session } from '../auth';
import { esc } from '../util';
import { describeError, formatUnits, fmtTime, parseUnits, shortHex } from '../links/format';
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
  /** Funding dialog open, and the chain-side progress line. */
  funding: boolean;
  fundingNote: string | null;
  walletTokenBalance: string | null;
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
  if (state === 'payable' && s.manifestOk && paidHere === null && s.stage === 'idle' && s.request.reserved) {
    action = `<p class="pl-small" style="text-align:center;margin:0">Another payer reserved this request a few minutes ago. If they do not complete it, the reservation expires and this page updates by itself.</p>`;
  } else if (state === 'payable' && s.manifestOk && paidHere !== null && s.stage === 'idle') {
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
      const evm = session();
      const suggested = ns ? formatUnits(((BigInt(m.amount) - BigInt(s.balance) + 10n ** BigInt(ns.decimals) - 1n) / 10n ** BigInt(ns.decimals) * 10n ** BigInt(ns.decimals)).toString(), ns.decimals, 0) : '';
      const fundForm = ns?.available
        ? evm.address
          ? `<form id="pay-fund-form" class="pl-notice" style="margin:0">
               <div class="pl-small" style="margin-bottom:8px">wallet <span class="pl-mono">${esc(shortHex(evm.address, 6, 4))}</span>${s.walletTokenBalance !== null ? ` · ${formatUnits(s.walletTokenBalance, ns.decimals)} ${esc(symbol)} on ${esc(ns.chain_name)}` : ''}</div>
               <label class="pl-field"><span class="pl-label">deposit (${esc(symbol)})</span><div class="pl-amount-input"><input class="pl-input" name="amount" inputmode="decimal" required value="${esc(suggested)}"></div><div class="pl-hint">two wallet confirmations: approve, then deposit. Credited after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}; the deposit is public on ${esc(ns.chain_name)}.</div></label>
               ${s.fundingNote ? `<div class="pl-small" role="status" style="margin-bottom:8px"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(s.fundingNote)}</span></div>` : ''}
               <button type="submit" class="pl-btn pl-btn-primary pl-btn-block" ${s.fundingNote ? 'disabled' : ''}>Deposit from wallet</button>
             </form>`
          : `<div class="pl-actions" style="margin:0"><button type="button" class="pl-btn pl-btn-primary" id="pay-login">Connect wallet</button>${injectedProvider() ? `<button type="button" class="pl-btn" id="pay-login-injected">Use browser wallet</button>` : ''}</div>
             <p class="pl-small" style="margin:8px 0 0">Funds come from your own wallet on ${esc(ns.chain_name)} as a public deposit into the gateway.</p>`
        : l.status.dev_mint
          ? `<button type="button" class="pl-btn pl-btn-block" id="pay-dev-mint" title="development fixture">Add test funds (dev mint) and continue</button>`
          : `<div class="pl-small" style="text-align:center">Deposits on ${esc(ns?.chain_name ?? 'this chain')} are not available on this node.</div>`;
      action = `
        <div class="pl-notice pl-notice-warn"><strong>Not enough balance.</strong> Available ${ns ? formatUnits(s.balance, ns.decimals) : s.balance} ${esc(symbol)}; this request needs ${short} ${esc(symbol)} more.</div>
        ${fundForm}`;
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
  const l0Namespace = () => {
    const l = links();
    return l.status?.namespaces.find((n) => n.id === s.request?.manifest.namespace) ?? null;
  };
  const previousTitle = document.title;
  document.title = 'Peal Links. payment request';
  const unmeta = [setMeta('robots', 'noindex, nofollow'), setMeta('referrer', 'no-referrer')];
  let stale = false;
  const s: PayState = { request: null, manifestOk: null, stage: 'idle', error: null, busy: null, balance: null, position: null, intentId: intentFor(requestId), funding: false, fundingNote: null, walletTokenBalance: null };
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
      const ns = l0Namespace();
      s.error = e instanceof LinksApiError && e.code === 'reserved' ? 'Someone else is completing this payment right now. Try again in a few minutes.' : describeError(e, ns?.chain_name, ns?.chain_id);
      if (s.stage !== 'accepted' && s.stage !== 'delivered' && s.stage !== 'delivery_pending') s.stage = 'idle';
    } finally {
      s.busy = null;
      await refreshBalance().catch(() => {});
      paint();
    }
  };

  const pay = async (account: LinksAccount) => {
    const req = await client.getRequest(requestId, s.intentId);
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

  const refreshWalletBalance = async () => {
    const l = links();
    const evm = session();
    const ns = l.status?.namespaces.find((n) => n.id === s.request?.manifest.namespace);
    if (!ns || !evm.address || !evm.provider || !ns.available) {
      s.walletTokenBalance = null;
      return;
    }
    try {
      s.walletTokenBalance = (await tokenBalance(ns, evm.address as Address, evm.provider as unknown as EIP1193Provider)).toString();
    } catch {
      s.walletTokenBalance = null;
    }
  };

  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const data = new FormData(form);
    const pass = String(data.get('pass') ?? '');
    const l = links();
    if (form.id === 'pay-unlock') void run('unlocking', null, async () => void (await openAccount(pass)));
    else if (form.id === 'pay-create') void run('creating your private account and registering it', null, async () => void (await createAccount(pass)));
    else if (form.id === 'pay-fund-form' && l.account && s.request) {
      const ns = l.status!.namespaces.find((n) => n.id === s.request!.manifest.namespace)!;
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      const evm = session();
      if (!amount || amount === '0' || !evm.address || !evm.provider) {
        s.error = 'enter an amount and connect a wallet';
        paint();
        return;
      }
      const account = l.account;
      void (async () => {
        s.error = null;
        try {
          s.fundingNote = 'proving the deposit intent';
          paint();
          const { receipt } = await account.prepareDeposit(amount);
          s.fundingNote = 'confirm the approval and the deposit in your wallet';
          paint();
          const tx = await depositOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, BigInt(amount), receipt);
          s.fundingNote = `deposit confirmed on chain (${shortHex(tx.depositHash, 8, 6)}); waiting for ${ns.confirmations} confirmation${ns.confirmations === 1 ? '' : 's'} and the ledger credit`;
          paint();
          // Poll until the watcher credits the intent, then claim it.
          for (let i = 0; i < 120; i++) {
            const credited = await account.syncDeposits();
            if (credited.length) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          await account.verifyReceipts();
          const v = await account.view();
          const idx = v.receipts.findIndex((r) => r.receipt === receipt && r.status === 'unclaimed');
          if (idx < 0) throw new Error('the deposit was not credited in time; it will appear under incoming receipts once the watcher sees it');
          s.fundingNote = 'claiming the deposit: proving on this device (about 7 s)';
          paint();
          await account.claim(idx);
          s.fundingNote = null;
        } catch (e) {
          s.fundingNote = null;
          s.error = describeError(e, ns.chain_name, ns.chain_id);
        }
        await refreshBalance().catch(() => {});
        await refreshWalletBalance();
        paint();
      })();
    }
  });

  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn) return;
    const l = links();
    if (btn.id === 'pay-now' && l.account) void pay(l.account);
    else if (btn.id === 'pay-login') session().login();
    else if (btn.id === 'pay-login-injected') void connectInjected().then(refreshWalletBalance).then(paint).catch((e) => { s.error = describeError(e); paint(); });
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
  const unsubAuth = onAuthChange(() => {
    void refreshWalletBalance().then(paint);
  });

  void (async () => {
    await loadStatus();
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

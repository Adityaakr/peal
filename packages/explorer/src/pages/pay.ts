// Peal Links: public checkout (#/pay/:requestId).
//
// Works without a wallet until payment is initiated. The page shows what the
// signed manifest says and nothing it does not: the payee's display name is
// self-chosen and labelled so, the amount is exact base units formatted with
// the asset's decimals, and every terminal state (expired, fulfilled, not
// found, node unreachable) is its own honest screen. Paying itself arrives
// with the wallet SDK (Phase C/E); until then the action is not rendered as
// an active control.
import { esc } from '../util';
import {
  getRequest,
  getStatus,
  LinksApiError,
  REQUEST_ID,
  type LinksStatus,
  type PaymentRequest,
} from '../links/api';
import { formatUnits, fmtTime, shortHex } from '../links/format';
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

function checkout(req: PaymentRequest, status: LinksStatus): string {
  const m = req.manifest;
  const ns = status.namespaces.find((n) => n.id === m.namespace);
  const amount = ns ? formatUnits(m.amount, ns.decimals) : m.amount;
  const symbol = ns ? ns.token_symbol : 'units';
  const expired = m.expires_at !== null && m.expires_at * 1000 < Date.now();
  const state: 'payable' | 'expired' | 'fulfilled' | 'archived' | 'unavailable' =
    req.status === 'fulfilled'
      ? 'fulfilled'
      : req.status === 'archived'
        ? 'archived'
        : expired || req.status === 'expired'
          ? 'expired'
          : !ns || !ns.available
            ? 'unavailable'
            : 'payable';
  const stateLine = {
    payable: `<span class="pl-status"><span class="pl-status-dot"></span>awaiting payment</span>`,
    expired: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>expired ${m.expires_at ? esc(fmtTime(m.expires_at)) : ''}</span>`,
    fulfilled: `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>paid · acknowledged by the receiver${req.fulfilled_at ? ` ${esc(fmtTime(req.fulfilled_at))}` : ''}</span>`,
    archived: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>this request was withdrawn by its creator</span>`,
    unavailable: `<span class="pl-status pl-status-bad"><span class="pl-status-dot"></span>the payment network for this request is not available</span>`,
  }[state];
  const action =
    state === 'payable'
      ? `<button type="button" class="pl-btn pl-btn-primary pl-btn-block" disabled title="paying arrives with the wallet SDK (Phase C)">Pay ${amount} ${esc(symbol)}</button>
         <p class="pl-small" style="text-align:center;margin:0">Paying from this page is the next step of the build and is not enabled yet. The request is genuine and signed; nothing here can take funds.</p>`
      : '';
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
      <div class="pl-row"><span class="pl-row-label">fee</span><span class="pl-row-value">none on the private ledger · chain gas only when funding</span></div>
      ${m.reference ? `<div class="pl-row"><span class="pl-row-label">reference</span><span class="pl-row-value">${esc(m.reference)}</span></div>` : ''}
      <div class="pl-row"><span class="pl-row-label">created</span><span class="pl-row-value">${esc(fmtTime(m.created_at))}</span></div>
      ${m.expires_at ? `<div class="pl-row"><span class="pl-row-label">expires</span><span class="pl-row-value">${esc(fmtTime(m.expires_at))}</span></div>` : ''}
      <div class="pl-row"><span class="pl-row-label">signed request</span><span class="pl-row-value pl-mono">${esc(shortHex(m.signature, 8, 6))}</span></div>
    </div>
    <div>${stateLine}</div>
    <div class="pl-checkout-actions">${action}</div>
  `);
}

export function renderPay(root: HTMLElement, requestId: string): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. payment request';
  const unmeta = [setMeta('robots', 'noindex, nofollow'), setMeta('referrer', 'no-referrer')];
  let stale = false;

  if (!REQUEST_ID.test(requestId)) {
    root.innerHTML = problem('not a payment link', 'This address does not name a payment request. Check the link you were sent.');
  } else {
    root.innerHTML = card(`<span class="pl-product-label">Peal Links</span><div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div>`);
    void Promise.all([getRequest(requestId), getStatus()])
      .then(([req, status]) => {
        if (stale) return;
        root.innerHTML = checkout(req, status);
      })
      .catch((err: unknown) => {
        if (stale) return;
        if (err instanceof LinksApiError && err.status === 404) {
          root.innerHTML = problem('request not found', 'The Peal Links node does not know this request. It may have been created on another deployment, or the local stack was reset.');
        } else if (err instanceof LinksApiError && err.status === 0) {
          root.innerHTML = problem('could not reach the network', 'The Peal Links node is not reachable. The request is not lost; try again once the stack is running.');
        } else {
          root.innerHTML = problem('something went wrong', esc(err instanceof Error ? err.message : String(err)));
        }
      });
  }

  return () => {
    stale = true;
    for (const f of unmeta) f();
    document.title = previousTitle;
  };
}

// Peal Links: the authenticated app (#/bonsai/app).
//
// Phase B ships the shell: header, balances per asset domain, requests,
// activity, and the account setup path, all rendered from the node's real
// status. Nothing on this page is fixture data. Until the wallet SDK lands
// (Phase C) the controls that would move funds are not rendered as active
// controls: the page says which step of the build they are waiting on.
import { onAuthChange, session } from '../auth';
import { esc } from '../util';
import { getStatus, LinksApiError, type LinksStatus, type NamespaceInfo } from '../links/api';
import { formatUnits } from '../links/format';
import '../links.css';

function unreachable(err: unknown): string {
  const detail =
    err instanceof LinksApiError && err.status !== 0
      ? `The node answered ${err.status}: ${esc(err.message)}.`
      : 'The Peal Links node is not reachable from this page.';
  return `
    <div class="pl-notice pl-notice-warn">
      <strong>Services are not running.</strong> ${detail}
      Start the local stack and reload:
      <pre class="pl-code">scripts/peal-links/stack.sh up</pre>
    </div>`;
}

function balanceCard(ns: NamespaceInfo): string {
  const demo = ns.environment !== 'mainnet';
  return `
    <div class="pl-balance" data-namespace="${esc(ns.id)}">
      <div class="pl-balance-label">
        <span>${esc(ns.token_symbol)} on ${esc(ns.chain_name)}</span>
        ${demo ? `<span class="pl-badge pl-badge-demo">${esc(ns.environment)} funds</span>` : ''}
      </div>
      <div class="pl-balance-amount">${formatUnits('0', ns.decimals)}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
      <div class="pl-balance-sub">available · ${formatUnits('0', ns.decimals)} incoming, unclaimed</div>
      ${ns.available ? '' : `<div class="pl-small" style="margin-top:8px">configured, not available: no verified deployment on this chain</div>`}
    </div>`;
}

function shell(status: LinksStatus, signedIn: boolean): string {
  const setupNote =
    status.setup === 'local-dev'
      ? `<div class="pl-notice"><strong>Local development setup.</strong> The proving keys on this node were generated locally, the ledger runs in ${esc(status.ledger_mode)} mode, and every balance is in ${esc(
          status.namespaces[0]?.environment ?? 'local',
        )} funds. This is the demo trust model, stated plainly.</div>`
      : '';
  const account = signedIn
    ? `<div class="pl-notice">
        <strong>Private account.</strong> Your wallet is connected. Creating or restoring the private account that holds your balance is the next step of this build (Phase C) and is not offered yet. Nothing on this page can move funds until it is.
      </div>`
    : `<div class="pl-notice">
        <strong>Sign in to continue.</strong> Requests and balances belong to a private account that is created after you connect a wallet. Connecting a wallet alone does not recover an existing account; the encrypted backup does.
        <div style="margin-top:10px"><button type="button" class="pl-btn pl-btn-primary" id="pl-login">Connect wallet</button></div>
      </div>`;
  return `
    <div class="pl">
      <div class="pl-wrap pl-app">
        <div class="pl-app-head">
          <div>
            <span class="pl-product-label">Peal Links</span>
            <h1 class="pl-app-title">payments</h1>
          </div>
          <div class="pl-small">circuit <span class="pl-mono">${esc(status.circuit_id.slice(0, 12))}…</span></div>
        </div>
        ${setupNote}
        ${account}
        <div class="pl-balances">${status.namespaces.map(balanceCard).join('')}</div>
        <div class="pl-actions">
          <button type="button" class="pl-btn pl-btn-primary" disabled title="available once the private account exists (Phase C)">New payment link</button>
          <button type="button" class="pl-btn" disabled title="available once the private account exists (Phase C)">Add funds</button>
          <button type="button" class="pl-btn" disabled title="available once the private account exists (Phase C)">Withdraw</button>
        </div>
        <div class="pl-panel">
          <div class="pl-panel-head"><h2 class="pl-panel-title">requests</h2><span class="pl-small">0</span></div>
          <div class="pl-empty">No payment requests yet. A request is a fixed amount in one asset, signed by your account, that anyone with the link can pay once.</div>
        </div>
        <div class="pl-panel">
          <div class="pl-panel-head"><h2 class="pl-panel-title">activity</h2></div>
          <div class="pl-empty">Deposits, payments sent and received, claims and withdrawals appear here, decrypted on this device.</div>
        </div>
        <div class="pl-panel">
          <div class="pl-panel-head"><h2 class="pl-panel-title">ledger</h2><span class="pl-small">${esc(status.ledger_mode)}</span></div>
          <ul class="pl-list">
            ${status.ledgers
              .map((l) => {
                const ns = status.namespaces.find((n) => n.id === l.namespace);
                return `<li><span class="pl-list-main">${esc(ns?.label ?? l.namespace.slice(0, 12))}</span><span class="pl-list-sub">state root <span class="pl-mono">${esc(l.state_root.slice(0, 16))}…</span></span><span class="pl-list-side">${l.receipt_count} receipts · seq ${l.seq}</span></li>`;
              })
              .join('')}
          </ul>
        </div>
      </div>
    </div>`;
}

export function renderBonsaiApp(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Links. payments';
  let stale = false;
  root.innerHTML = `<div class="pl"><div class="pl-wrap pl-app"><span class="pl-product-label">Peal Links</span><h1 class="pl-app-title">payments</h1><div class="skeleton-row"><span class="skeleton" style="width:240px"></span></div></div></div>`;

  let status: LinksStatus | null = null;
  const paint = () => {
    if (stale || !status) return;
    root.innerHTML = shell(status, !!session().address);
    root.querySelector<HTMLButtonElement>('#pl-login')?.addEventListener('click', () => session().login());
  };
  const unsubscribe = onAuthChange(paint);

  void getStatus()
    .then((s) => {
      status = s;
      paint();
    })
    .catch((err) => {
      if (stale) return;
      root.innerHTML = `<div class="pl"><div class="pl-wrap pl-app"><span class="pl-product-label">Peal Links</span><h1 class="pl-app-title">payments</h1>${unreachable(err)}</div></div>`;
    });

  return () => {
    stale = true;
    unsubscribe();
    document.title = previousTitle;
  };
}

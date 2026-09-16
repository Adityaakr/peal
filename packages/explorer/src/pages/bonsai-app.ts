// Peal Links: the app (#/bonsai/app).
//
// Everything on this page is read from the node and from the wallet inside
// the proving worker; nothing is fixture data. Controls that cannot work
// yet are not rendered as if they could: they say which part of the build
// they wait on. Money is base units as decimal strings until the moment it
// is formatted for a human.
import QRCode from 'qrcode';
import type { LinksAccount, PaymentRequest, WalletView } from 'peal-links';
import { depositOnChain, LinksApiError, tokenBalance, withdrawOnChain } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, injectedProvider, onAuthChange, session } from '../auth';
import { esc } from '../util';
import { formatUnits, fmtTime, parseUnits, shortHex } from '../links/format';
import {
  client,
  createAccount,
  links,
  loadStatus,
  lockAccount,
  onLinksChange,
  openAccount,
  restoreAccount,
  resumeSignIn,
  selectNamespace,
  setAutoClaim,
  signIn,
} from '../links/session';
import '../links.css';

type Cleanup = () => void;

// ---- page-local state ---------------------------------------------------

interface PageState {
  view: WalletView | null;
  requests: PaymentRequest[];
  busy: string | null; // a running operation, shown as status
  error: string | null;
  notice: string | null;
  lastLink: { request: PaymentRequest; url: string; qr: string } | null;
  walletTokenBalance: string | null;
  withdrawals: Array<{ position: number; amount: string; recipient: string; status: string; tx_hash: string | null }>;
}

let page: PageState = { view: null, requests: [], busy: null, error: null, notice: null, lastLink: null, walletTokenBalance: null, withdrawals: [] };

function requestUrl(id: string): string {
  return `${location.origin}/pay/${id}`;
}

// ---- rendering helpers ------------------------------------------------------

function unreachable(err: string): string {
  return `
    <div class="pl-notice pl-notice-warn">
      <strong>Services are not running.</strong> ${esc(err)}. Start the local stack and reload:
      <pre class="pl-code">scripts/peal-links/stack.sh up</pre>
    </div>`;
}

function statusChip(status: string): string {
  const tone = status === 'fulfilled' ? 'pl-status-ok' : status === 'active' ? 'pl-status-pending' : 'pl-status-bad';
  return `<span class="pl-status ${tone}"><span class="pl-status-dot"></span>${esc(status)}</span>`;
}

function receiptStatus(status: string): string {
  const label =
    status === 'unclaimed' ? 'ready to claim' : status === 'claiming' ? 'claiming' : status === 'claimed' ? 'claimed' : status === 'invalid' ? 'invalid' : 'checking';
  const tone = status === 'claimed' ? 'pl-status-ok' : status === 'invalid' ? 'pl-status-bad' : status === 'unclaimed' ? 'pl-status-pending' : '';
  return `<span class="pl-status ${tone}"><span class="pl-status-dot"></span>${label}</span>`;
}

function setupNotice(): string {
  const s = links().status!;
  const ns = links().namespace!;
  return s.setup === 'local-dev'
    ? `<div class="pl-notice"><strong>Local development setup.</strong> Proving keys generated locally (no ceremony), ledger in ${esc(s.ledger_mode)} mode, balances in ${esc(ns.environment)} funds. This is the demo's trust model, stated plainly.</div>`
    : '';
}

function accountPanel(): string {
  const l = links();
  const evm = session();
  const injected = injectedProvider();
  const connect = evm.address
    ? `<span class="pl-small">wallet <span class="pl-mono">${esc(shortHex(evm.address, 6, 4))}</span></span>
       ${l.signedIn ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>signed in</span>` : `<button type="button" class="pl-btn" id="pl-signin">Sign in</button>`}`
    : `<button type="button" class="pl-btn" id="pl-login">Connect wallet</button>${injected ? `<button type="button" class="pl-btn" id="pl-login-injected">Use browser wallet</button>` : ''}`;

  if (l.account && page.view) {
    const v = page.view;
    return `
      <div class="pl-panel">
        <div class="pl-panel-head">
          <h2 class="pl-panel-title">private account</h2>
          <div class="pl-actions" style="margin:0">${connect}<button type="button" class="pl-btn" id="pl-lock">Lock</button></div>
        </div>
        <div style="padding:14px 18px" class="pl-small">
          account <span class="pl-mono">${esc(shortHex(v.account, 10, 6))}</span> · encryption key <span class="pl-mono">${esc(shortHex(v.enc_pubkey, 8, 4))}</span>
          ${v.pending ? ` · <span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(v.pending)} pending</span>` : ''}
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button type="button" class="pl-btn" id="pl-backup">Export encrypted backup</button>
            <label class="pl-small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}> claim incoming receipts automatically while unlocked</label>
          </div>
        </div>
      </div>`;
  }
  if (l.hasStoredAccount) {
    return `
      <div class="pl-panel">
        <div class="pl-panel-head"><h2 class="pl-panel-title">unlock your private account</h2><div>${connect}</div></div>
        <form id="pl-unlock" style="padding:14px 18px">
          <label class="pl-field"><span class="pl-label">passphrase</span><input class="pl-input" type="password" name="pass" autocomplete="current-password" required minlength="10"></label>
          <div class="pl-actions" style="margin:0"><button type="submit" class="pl-btn pl-btn-primary">Unlock</button><button type="button" class="pl-btn" id="pl-show-restore">Restore from backup instead</button></div>
        </form>
      </div>`;
  }
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">set up your private account</h2><div>${connect}</div></div>
      <div style="padding:14px 18px">
        <p class="pl-p">Your balance lives in a private account on the ledger. Its keys are generated here, in your browser, and stored encrypted under a passphrase. <strong>Connecting a wallet does not recover it.</strong> If this browser's storage is lost, only the encrypted backup you export brings the account back; without it the funds cannot be moved by anyone.</p>
        <form id="pl-create">
          <label class="pl-field"><span class="pl-label">passphrase (at least 10 characters)</span><input class="pl-input" type="password" name="pass" autocomplete="new-password" required minlength="10"></label>
          <label class="pl-field"><span class="pl-label">repeat it</span><input class="pl-input" type="password" name="pass2" autocomplete="new-password" required minlength="10"></label>
          <div class="pl-actions" style="margin:0"><button type="submit" class="pl-btn pl-btn-primary">Create private account</button><button type="button" class="pl-btn" id="pl-show-restore">Restore from backup</button></div>
        </form>
      </div>
    </div>`;
}

function restoreDialog(): string {
  return `
    <dialog class="pl-dialog" id="pl-restore-dialog">
      <form class="pl-dialog-body" id="pl-restore" method="dialog">
        <h3 class="pl-dialog-title">restore from backup</h3>
        <p class="pl-small">The backup file is encrypted with the passphrase you chose when exporting it. After restoring, the account is checked against the ledger; a backup older than your last operation is reported as stale rather than used.</p>
        <label class="pl-field"><span class="pl-label">backup file</span><input class="pl-input" type="file" name="file" accept="application/json,.json" required></label>
        <label class="pl-field"><span class="pl-label">backup passphrase</span><input class="pl-input" type="password" name="bpass" required></label>
        <label class="pl-field"><span class="pl-label">new passphrase for this browser</span><input class="pl-input" type="password" name="pass" required minlength="10" autocomplete="new-password"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Restore</button></div>
      </form>
    </dialog>`;
}

function balances(): string {
  const ns = links().namespace!;
  const v = page.view;
  const demo = ns.environment !== 'mainnet';
  const avail = v ? formatUnits(v.balance, ns.decimals) : formatUnits('0', ns.decimals);
  const incoming = v ? formatUnits(v.unclaimed, ns.decimals) : formatUnits('0', ns.decimals);
  return `
    <div class="pl-balances">
      <div class="pl-balance">
        <div class="pl-balance-label"><span>available · ${esc(ns.token_symbol)} on ${esc(ns.chain_name)}</span>${demo ? `<span class="pl-badge pl-badge-demo">${esc(ns.environment)} funds</span>` : ''}</div>
        <div class="pl-balance-amount">${avail}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-sub">${v ? 'spendable now' : 'unlock your account to see it'}</div>
      </div>
      <div class="pl-balance">
        <div class="pl-balance-label"><span>incoming · verified, not yet claimed</span></div>
        <div class="pl-balance-amount">${incoming}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-sub">claiming adds it to available</div>
      </div>
    </div>`;
}

function actions(): string {
  const l = links();
  const unlocked = !!l.account;
  const canRequest = unlocked && !!l.signedIn;
  const devMint = !!l.status?.dev_mint;
  const nsAvail = !!l.namespace?.available;
  const hasWallet = !!session().address;
  return `
    <div class="pl-actions">
      <button type="button" class="pl-btn pl-btn-primary" id="pl-new-request" ${canRequest ? '' : 'disabled'} title="${canRequest ? '' : unlocked ? 'sign in with your wallet to publish requests' : 'unlock your private account first'}">New payment link</button>
      ${
        nsAvail
          ? `<button type="button" class="pl-btn" id="pl-add-funds" ${unlocked && hasWallet ? '' : 'disabled'} title="${hasWallet ? '' : 'connect a wallet to deposit from'}">Add funds</button>`
          : devMint
            ? `<button type="button" class="pl-btn" id="pl-dev-mint" ${unlocked ? '' : 'disabled'} title="development fixture: credits test funds without a chain deposit">Add test funds (dev mint)</button>`
            : `<button type="button" class="pl-btn" disabled title="deposits are not available on this namespace">Add funds</button>`
      }
      ${
        nsAvail && l.status?.signer_mode !== 'none'
          ? `<button type="button" class="pl-btn" id="pl-withdraw" ${unlocked && hasWallet ? '' : 'disabled'} title="${hasWallet ? '' : 'connect a wallet to submit the release'}">Withdraw</button>`
          : `<button type="button" class="pl-btn" disabled title="withdrawals are not available on this namespace">Withdraw</button>`
      }
    </div>`;
}

function requestsPanel(): string {
  const l = links();
  const ns = l.namespace!;
  const rows = page.requests
    .map((r) => {
      const m = r.manifest;
      return `<li>
        <span class="pl-list-main">${esc(m.title)}</span>
        <span class="pl-list-sub">${statusChip(r.status)} · ${esc(fmtTime(m.created_at))}${m.reference ? ` · ${esc(m.reference)}` : ''} · <button type="button" class="pl-linkbtn" data-copy="${esc(requestUrl(m.request_id))}">copy link</button> · <a class="pl-linkbtn" href="#/pay/${esc(m.request_id)}">open</a>${r.status === 'active' ? ` · <button type="button" class="pl-linkbtn" data-archive="${esc(m.request_id)}">archive</button>` : ''}</span>
        <span class="pl-list-side">${formatUnits(m.amount, ns.decimals)} ${esc(ns.token_symbol)}</span>
      </li>`;
    })
    .join('');
  const empty = l.signedIn
    ? 'No payment requests yet. A request is a fixed amount in one asset, signed by your account, that anyone with the link can pay.'
    : 'Sign in with your wallet to see and create your payment requests.';
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">requests</h2><span class="pl-small">${page.requests.length}</span></div>
      ${rows ? `<ul class="pl-list">${rows}</ul>` : `<div class="pl-empty">${empty}</div>`}
    </div>`;
}

function receiptsPanel(): string {
  const ns = links().namespace!;
  const v = page.view;
  if (!v) return '';
  const rows = v.receipts
    .slice()
    .reverse()
    .map(
      (r, i) => `<li>
        <span class="pl-list-main">${r.sender === MINT_SENDER ? 'deposit' : `from ${esc(shortHex(r.sender, 8, 4))}`}${r.reference ? ` · for request ${esc(r.reference.slice(0, 8))}…` : ''}</span>
        <span class="pl-list-sub">${receiptStatus(r.status)} · receipt #${r.position} · ${esc(fmtTime(r.discovered_at))}${r.status === 'unclaimed' ? ` · <button type="button" class="pl-linkbtn" data-claim="${v.receipts.length - 1 - i}">claim now</button>` : ''}</span>
        <span class="pl-list-side">${formatUnits(r.amount, ns.decimals)} ${esc(ns.token_symbol)}</span>
      </li>`,
    )
    .join('');
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">incoming receipts</h2><span class="pl-small">${v.receipts.length}</span></div>
      ${rows ? `<ul class="pl-list">${rows}</ul>` : `<div class="pl-empty">Receipts addressed to you appear here once their encrypted opening reaches your inbox. Claiming one proves it is yours and adds it to your balance.</div>`}
    </div>`;
}

function activityPanel(): string {
  const ns = links().namespace!;
  const v = page.view;
  if (!v) return '';
  const rows = v.history
    .slice()
    .reverse()
    .map(
      (h) => `<li>
        <span class="pl-list-main">${h.kind === 'send' ? `sent to ${esc(shortHex(h.counterparty, 8, 4))}` : h.counterparty === MINT_SENDER ? 'deposit claimed' : `received from ${esc(shortHex(h.counterparty, 8, 4))}`}${h.reference ? ` · request ${esc(h.reference.slice(0, 8))}…` : ''}</span>
        <span class="pl-list-sub">${esc(fmtTime(h.at))}${h.position !== null ? ` · receipt #${h.position}` : ''}</span>
        <span class="pl-list-side">${h.kind === 'send' ? '−' : '+'}${formatUnits(h.amount, ns.decimals)} ${esc(ns.token_symbol)}</span>
      </li>`,
    )
    .join('');
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">activity</h2><span class="pl-small">decrypted on this device</span></div>
      ${rows ? `<ul class="pl-list">${rows}</ul>` : `<div class="pl-empty">Deposits, payments sent and received, and claims appear here.</div>`}
    </div>`;
}

function ledgerPanel(): string {
  const s = links().status!;
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">ledger</h2><span class="pl-small">${esc(s.ledger_mode)} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></span></div>
      <ul class="pl-list">
        ${s.ledgers
          .map((l) => {
            const ns = s.namespaces.find((n) => n.id === l.namespace);
            return `<li><span class="pl-list-main">${esc(ns?.label ?? l.namespace.slice(0, 12))}</span><span class="pl-list-sub">state root <span class="pl-mono">${esc(l.state_root.slice(0, 16))}…</span></span><span class="pl-list-side">${l.receipt_count} receipts · seq ${l.seq}</span></li>`;
          })
          .join('')}
      </ul>
    </div>`;
}

function newRequestDialog(): string {
  const ns = links().namespace!;
  return `
    <dialog class="pl-dialog" id="pl-request-dialog">
      <form class="pl-dialog-body" id="pl-request-form" method="dialog">
        <h3 class="pl-dialog-title">new payment link</h3>
        <label class="pl-field"><span class="pl-label">what is it for</span><input class="pl-input" name="title" maxlength="140" required placeholder="Logo files, final"></label>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)} on ${esc(ns.chain_name)})</span><div class="pl-amount-input"><input class="pl-input" name="amount" inputmode="decimal" required placeholder="0.00"></div><div class="pl-hint">exact amount; the link can be paid once</div></label>
        <label class="pl-field"><span class="pl-label">your display name</span><input class="pl-input" name="display" maxlength="60" required placeholder="shown to the payer, not verified"></label>
        <label class="pl-field"><span class="pl-label">reference (optional)</span><input class="pl-input" name="reference" maxlength="64" placeholder="INV-0417"></label>
        <label class="pl-field"><span class="pl-label">expires (optional)</span><input class="pl-input" name="expires" type="datetime-local"></label>
        <p class="pl-small">The title, amount and display name are public to anyone holding the link. Keep sensitive details out of them.</p>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Create link</button></div>
      </form>
    </dialog>`;
}

function linkDialog(): string {
  const l = page.lastLink;
  if (!l) return '';
  const ns = links().namespace!;
  return `
    <dialog class="pl-dialog" id="pl-link-dialog">
      <div class="pl-dialog-body">
        <h3 class="pl-dialog-title">your payment link</h3>
        <p class="pl-small">${esc(l.request.manifest.title)} · ${formatUnits(l.request.manifest.amount, ns.decimals)} ${esc(ns.token_symbol)}</p>
        <div class="pl-qr" aria-label="QR code of the payment link">${l.qr}</div>
        <div class="pl-share-link" style="margin-top:12px"><input class="pl-input" readonly value="${esc(l.url)}" id="pl-link-url"><button type="button" class="pl-btn" data-copy="${esc(l.url)}">Copy</button></div>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn pl-btn-primary" data-close>Done</button></div>
      </div>
    </dialog>`;
}

function fundDialog(): string {
  const ns = links().namespace!;
  const evm = session();
  return `
    <dialog class="pl-dialog" id="pl-fund-dialog">
      <form class="pl-dialog-body" id="pl-fund-form" method="dialog">
        <h3 class="pl-dialog-title">add funds</h3>
        <p class="pl-small">A public deposit of ${esc(ns.token_symbol)} from your wallet <span class="pl-mono">${esc(shortHex(evm.address ?? '', 6, 4))}</span> into the gateway on ${esc(ns.chain_name)}${page.walletTokenBalance !== null ? ` (wallet holds ${formatUnits(page.walletTokenBalance, ns.decimals)} ${esc(ns.token_symbol)})` : ''}. Two wallet confirmations: approve, then deposit. Credited to your private balance after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}; the amount and your address are visible on the chain, the private account is not.</p>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)})</span><input class="pl-input" name="amount" inputmode="decimal" required placeholder="0.00"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Deposit from wallet</button></div>
      </form>
    </dialog>`;
}

function withdrawDialog(): string {
  const ns = links().namespace!;
  const s = links().status!;
  const v = page.view;
  return `
    <dialog class="pl-dialog" id="pl-withdraw-dialog">
      <form class="pl-dialog-body" id="pl-withdraw-form" method="dialog">
        <h3 class="pl-dialog-title">withdraw to ${esc(ns.chain_name)}</h3>
        <p class="pl-small">The amount is burned on the private ledger with a proof, then ${s.signer_threshold} of ${s.signers.length} settlement signers attest to its release and the gateway pays the recipient. This is a committee-attested bridge${s.signer_mode === 'single-process-fixture' ? ' and, on this node, the signers are a single-process fixture' : ''}: a compromised committee could release funds wrongly. The withdrawal is public on the chain.</p>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)}${v ? `, available ${formatUnits(v.balance, ns.decimals)}` : ''})</span><input class="pl-input" name="amount" inputmode="decimal" required placeholder="0.00"></label>
        <label class="pl-field"><span class="pl-label">recipient address on ${esc(ns.chain_name)}</span><input class="pl-input pl-mono" name="recipient" required pattern="0x[0-9a-fA-F]{40}" value="${esc(session().address ?? '')}"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Withdraw</button></div>
      </form>
    </dialog>`;
}

function withdrawalsPanel(): string {
  const ns = links().namespace!;
  if (!page.withdrawals.length) return '';
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">withdrawals</h2></div>
      <ul class="pl-list">
        ${page.withdrawals
          .map(
            (w) => `<li><span class="pl-list-main">to ${esc(shortHex(w.recipient, 6, 4))}</span><span class="pl-list-sub">${w.status === 'confirmed' ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>confirmed on chain</span>` : `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(w.status.replace('_', ' '))}</span>`}${w.tx_hash ? ` · tx <span class="pl-mono">${esc(shortHex(w.tx_hash, 8, 6))}</span>` : ''} · burn #${w.position}</span><span class="pl-list-side">${formatUnits(w.amount, ns.decimals)} ${esc(ns.token_symbol)}</span></li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

function devMintDialog(): string {
  const ns = links().namespace!;
  return `
    <dialog class="pl-dialog" id="pl-mint-dialog">
      <form class="pl-dialog-body" id="pl-mint-form" method="dialog">
        <h3 class="pl-dialog-title">add test funds</h3>
        <p class="pl-small"><strong>Development fixture.</strong> This node runs with the labelled dev-mint endpoint, which credits a deposit intent without a chain deposit. The intent, its proof and the claim are real; only the on-chain leg is stood in for. It does not exist on any deployment with real funds.</p>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)})</span><input class="pl-input" name="amount" inputmode="decimal" required value="100"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Credit test funds</button></div>
      </form>
    </dialog>`;
}

const MINT_SENDER_KEY = 'peal-links:mint-sender';
let MINT_SENDER = '';

function html(): string {
  const l = links();
  if (l.statusError || !l.status || !l.namespace) {
    return `<div class="pl"><div class="pl-wrap pl-app"><span class="pl-product-label">Peal Links</span><h1 class="pl-app-title">payments</h1>${l.statusError ? unreachable(l.statusError) : `<div class="skeleton-row"><span class="skeleton" style="width:240px"></span></div>`}</div></div>`;
  }
  const nsSelect =
    l.status.namespaces.length > 1
      ? `<select class="pl-select" id="pl-ns" style="width:auto;min-height:36px;font-size:13px">${l.status.namespaces.map((n) => `<option value="${esc(n.id)}" ${n.id === l.namespace!.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select>`
      : `<span class="pl-small">${esc(l.namespace.label)}</span>`;
  return `
    <div class="pl">
      <div class="pl-wrap pl-app">
        <div class="pl-app-head">
          <div><span class="pl-product-label">Peal Links</span><h1 class="pl-app-title">payments</h1></div>
          <div>${nsSelect}</div>
        </div>
        ${setupNotice()}
        ${page.error ? `<div class="pl-notice pl-notice-bad" role="alert">${esc(page.error)}</div>` : ''}
        ${page.notice ? `<div class="pl-notice" role="status">${esc(page.notice)}</div>` : ''}
        ${page.busy ? `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(page.busy)}</span></div>` : ''}
        ${l.paramsProgress ? `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(l.paramsProgress)}</span></div>` : ''}
        ${accountPanel()}
        ${balances()}
        ${actions()}
        ${requestsPanel()}
        ${receiptsPanel()}
        ${withdrawalsPanel()}
        ${activityPanel()}
        ${ledgerPanel()}
        ${restoreDialog()}
        ${newRequestDialog()}
        ${fundDialog()}
        ${withdrawDialog()}
        ${devMintDialog()}
        ${linkDialog()}
      </div>
    </div>`;
}

// ---- behaviour ---------------------------------------------------------------

export function renderBonsaiApp(root: HTMLElement): Cleanup {
  const previousTitle = document.title;
  document.title = 'Peal Links. payments';
  let stale = false;
  let syncTimer = 0;
  let claiming = false;
  page = { view: null, requests: [], busy: null, error: null, notice: null, lastLink: null, walletTokenBalance: null, withdrawals: [] };
  MINT_SENDER = localStorage.getItem(MINT_SENDER_KEY) ?? '';

  let deferredPaint = false;
  const paint = () => {
    if (stale) return;
    // Never replace the DOM under an open dialog (a file the person picked
    // cannot be restored); repaint once it closes.
    if (root.querySelector('dialog[open]') && !page.lastLink) {
      deferredPaint = true;
      return;
    }
    deferredPaint = false;
    // Preserve typed passphrases across re-renders triggered by auth events.
    const active = document.activeElement as HTMLInputElement | null;
    const activeName = active?.name;
    const activeValue = active?.value;
    root.innerHTML = html();
    if (page.lastLink) root.querySelector<HTMLDialogElement>('#pl-link-dialog')?.showModal();
    if (activeName) {
      const again = root.querySelector<HTMLInputElement>(`input[name="${activeName}"]`);
      if (again && activeValue !== undefined) {
        again.value = activeValue;
        again.focus();
      }
    }
  };

  const refreshWalletBalance = async () => {
    const l = links();
    const evm = session();
    if (!l.namespace?.available || !evm.address || !evm.provider) {
      page.walletTokenBalance = null;
      return;
    }
    try {
      page.walletTokenBalance = (await tokenBalance(l.namespace, evm.address as Address, evm.provider as unknown as EIP1193Provider)).toString();
    } catch {
      page.walletTokenBalance = null;
    }
  };

  const refresh = async () => {
    const l = links();
    if (!l.account) {
      page.view = null;
      return;
    }
    page.view = await l.account.view();
    // Withdrawals: every send whose reference is a withdraw marker.
    const burns = page.view.history.filter((h) => h.kind === 'send' && h.reference?.startsWith('withdraw:') && h.position !== null);
    const withdrawals = [];
    for (const b of burns) {
      try {
        const w = await client.withdrawal(l.namespace!.id, b.position!);
        withdrawals.push({ position: b.position!, amount: w.amount, recipient: w.recipient, status: w.status, tx_hash: w.tx_hash });
      } catch {
        withdrawals.push({ position: b.position!, amount: b.amount, recipient: b.reference!.slice('withdraw:'.length), status: 'burned, not yet settled', tx_hash: null });
      }
    }
    page.withdrawals = withdrawals;
    if (l.signedIn) {
      try {
        // Requests are owned by the signed-in wallet on the API; show only
        // the ones this private account receives, since another account on
        // the same wallet cannot claim them.
        const mine = page.view.account;
        page.requests = (await client.listRequests()).requests.filter((r) => r.manifest.receiver_account === mine);
      } catch (e) {
        if (e instanceof LinksApiError && e.status === 401) page.requests = [];
      }
    }
  };

  const run = async (label: string, f: () => Promise<void>) => {
    page.busy = label;
    page.error = null;
    paint();
    try {
      await f();
    } catch (e) {
      page.error = e instanceof Error ? e.message : String(e);
    } finally {
      page.busy = null;
      await refresh().catch(() => {});
      paint();
    }
  };

  const claimAll = async (account: LinksAccount) => {
    if (claiming) return;
    claiming = true;
    try {
      let v = await account.view();
      for (let i = 0; i < v.receipts.length; i++) {
        if (v.receipts[i]!.status !== 'unclaimed' || stale) continue;
        await run(`claiming receipt #${v.receipts[i]!.position}: proving on this device (about 7 s)`, async () => {
          await account.claim(i);
          const ref = v.receipts[i]!.reference;
          if (ref && /^[a-z2-7]{24}$/.test(ref)) await account.acknowledge(ref, v.receipts[i]!.position).catch(() => {});
        });
        v = await account.view();
      }
    } finally {
      claiming = false;
    }
  };

  const syncOnce = async () => {
    const l = links();
    if (!l.account || stale) return;
    try {
      await l.account.sync();
      await refresh();
      paint();
      if (l.autoClaim) await claimAll(l.account);
    } catch {
      /* next tick */
    }
  };

  root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button, a');
    if (!btn) return;
    const l = links();
    if (btn.id === 'pl-login') session().login();
    else if (btn.id === 'pl-login-injected') void run('connecting browser wallet', async () => void (await connectInjected()));
    else if (btn.id === 'pl-signin') void run('signing in: confirm the message in your wallet', () => signIn().then(() => undefined));
    else if (btn.id === 'pl-lock') {
      lockAccount();
      page.view = null;
      paint();
    } else if (btn.id === 'pl-show-restore') root.querySelector<HTMLDialogElement>('#pl-restore-dialog')?.showModal();
    else if (btn.id === 'pl-new-request') root.querySelector<HTMLDialogElement>('#pl-request-dialog')?.showModal();
    else if (btn.id === 'pl-dev-mint') root.querySelector<HTMLDialogElement>('#pl-mint-dialog')?.showModal();
    else if (btn.id === 'pl-add-funds') root.querySelector<HTMLDialogElement>('#pl-fund-dialog')?.showModal();
    else if (btn.id === 'pl-withdraw') root.querySelector<HTMLDialogElement>('#pl-withdraw-dialog')?.showModal();
    else if (btn.id === 'pl-backup') {
      const pass = prompt('Passphrase for the backup file (at least 10 characters). You will need it to restore.');
      if (!pass) return;
      void run('encrypting backup', async () => {
        const json = await l.account!.exportBackup(pass);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `peal-links-backup-${l.namespace!.label.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        page.notice = 'Backup exported. It contains your spending key and every receipt opening, encrypted: keep it somewhere safe.';
      });
    } else if (btn.dataset.copy) {
      void navigator.clipboard?.writeText(btn.dataset.copy).then(() => {
        const prev = btn.textContent;
        btn.textContent = 'copied';
        window.setTimeout(() => (btn.textContent = prev), 1200);
      });
    } else if (btn.dataset.claim !== undefined) {
      const idx = Number(btn.dataset.claim);
      void run(`claiming: proving on this device (about 7 s)`, async () => {
        const v = await l.account!.view();
        const r = v.receipts[idx]!;
        await l.account!.claim(idx);
        if (r.reference && /^[a-z2-7]{24}$/.test(r.reference)) await l.account!.acknowledge(r.reference, r.position).catch(() => {});
      });
    } else if (btn.dataset.archive) {
      const id = btn.dataset.archive;
      void run('archiving', async () => void (await client.archiveRequest(id)));
    } else if (btn.hasAttribute('data-close')) {
      btn.closest('dialog')?.close();
      if (btn.closest('#pl-link-dialog')) page.lastLink = null;
      if (deferredPaint || btn.closest('#pl-link-dialog')) paint();
    }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'pl-autoclaim') {
      setAutoClaim((t as HTMLInputElement).checked);
      if ((t as HTMLInputElement).checked) void syncOnce();
    } else if (t.id === 'pl-ns') {
      const ns = links().status?.namespaces.find((n) => n.id === t.value);
      if (ns) void selectNamespace(ns).then(refresh).then(paint);
    }
  });

  root.addEventListener('submit', (ev) => {
    const form = ev.target as HTMLFormElement;
    ev.preventDefault();
    const data = new FormData(form);
    const l = links();
    if (form.id === 'pl-create') {
      const pass = String(data.get('pass') ?? '');
      if (pass !== String(data.get('pass2') ?? '')) {
        page.error = 'the two passphrases differ';
        paint();
        return;
      }
      void run('creating your private account and registering it on the ledger', async () => {
        await createAccount(pass);
        page.notice = 'Account created and registered. Export a backup before receiving funds: this browser is the only place the keys exist.';
      });
    } else if (form.id === 'pl-unlock') {
      void run('unlocking', async () => {
        const account = await openAccount(String(data.get('pass') ?? ''));
        const v = await account.view();
        if (v.pending) {
          const r = await account.reconcile();
          page.notice = `A ${v.pending} was pending from an earlier session: ${r === 'committed' ? 'the ledger had accepted it, recorded' : r === 'aborted' ? 'the ledger had not seen it, dropped' : r}.`;
        }
      });
    } else if (form.id === 'pl-restore') {
      const file = data.get('file') as File | null;
      if (!file) return;
      form.closest('dialog')?.close();
      void run('restoring and checking against the ledger', async () => {
        const json = await file.text();
        const account = await restoreAccount(json, String(data.get('bpass') ?? ''), String(data.get('pass') ?? ''));
        const r = await account.reconcile();
        page.notice = r === 'conflict' ? 'Restored, but this backup is older than the account on the ledger. Do not use it to pay; restore a newer backup.' : 'Restored from backup.';
      });
    } else if (form.id === 'pl-request-form') {
      const ns = l.namespace!;
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0') {
        page.error = `enter an amount with at most ${ns.decimals} decimals`;
        paint();
        return;
      }
      const expiresRaw = String(data.get('expires') ?? '');
      const expiresAt = expiresRaw ? Math.floor(new Date(expiresRaw).getTime() / 1000) : null;
      form.closest('dialog')?.close();
      void run('signing and publishing the request', async () => {
        const request = await l.account!.createRequest({
          amount,
          title: String(data.get('title') ?? '').trim(),
          displayName: String(data.get('display') ?? '').trim(),
          reference: String(data.get('reference') ?? '').trim() || null,
          expiresAt,
        });
        const url = requestUrl(request.manifest.request_id);
        const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        page.lastLink = { request, url, qr };
      });
    } else if (form.id === 'pl-fund-form') {
      const ns = l.namespace!;
      const evm = session();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !evm.address || !evm.provider) {
        page.error = 'enter an amount and connect a wallet';
        paint();
        return;
      }
      form.closest('dialog')?.close();
      void run('deposit: proving the intent, then confirm the approval and the deposit in your wallet', async () => {
        const { receipt } = await l.account!.prepareDeposit(amount);
        const tx = await depositOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, BigInt(amount), receipt);
        page.notice = `Deposit confirmed on ${ns.chain_name} (tx ${shortHex(tx.depositHash, 8, 6)}). It is credited as an incoming receipt after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}; claim it to make it spendable.`;
      });
    } else if (form.id === 'pl-withdraw-form') {
      const ns = l.namespace!;
      const evm = session();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      const recipient = String(data.get('recipient') ?? '').trim();
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || !evm.address || !evm.provider) {
        page.error = 'enter an amount, a recipient address, and connect a wallet';
        paint();
        return;
      }
      form.closest('dialog')?.close();
      void run('withdrawal: proving the burn on this device (about 7 s), then the committee certificate, then confirm the release in your wallet', async () => {
        const { certificate } = await l.account!.withdraw(amount, recipient);
        const hash = await withdrawOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, certificate);
        page.notice = `Withdrawal released on ${ns.chain_name} (tx ${shortHex(hash, 8, 6)}) to ${shortHex(recipient, 6, 4)}.`;
      });
    } else if (form.id === 'pl-mint-form') {
      const ns = l.namespace!;
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0') {
        page.error = 'enter an amount';
        paint();
        return;
      }
      form.closest('dialog')?.close();
      void run('proving the deposit intent and crediting test funds', async () => {
        const { receipt } = await l.account!.prepareDeposit(amount, 'test funds (dev mint)');
        await client.devMint(ns.id, receipt);
        await l.account!.sync();
        const v = await l.account!.view();
        const mint = v.receipts.find((r) => r.receipt === receipt);
        if (mint && !MINT_SENDER) {
          MINT_SENDER = mint.sender;
          localStorage.setItem(MINT_SENDER_KEY, MINT_SENDER);
        }
        page.notice = 'Test funds credited as an incoming receipt. Claim it to make it spendable.';
      });
    }
  });

  const unsubAuth = onAuthChange(() => {
    void refreshWalletBalance().then(paint);
  });
  const unsubLinks = onLinksChange(() => {
    void refresh().then(paint);
  });

  paint();
  void (async () => {
    await loadStatus();
    await resumeSignIn();
    await refresh();
    await refreshWalletBalance();
    paint();
    syncTimer = window.setInterval(() => void syncOnce(), 5000);
  })();

  return () => {
    stale = true;
    window.clearInterval(syncTimer);
    unsubAuth();
    unsubLinks();
    document.title = previousTitle;
  };
}

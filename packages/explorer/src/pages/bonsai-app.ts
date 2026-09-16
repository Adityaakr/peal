// Peal Links: the app (#/bonsai/app).
//
// One wallet, private by default: the connected EVM wallet is the only
// identity on this page. The private account behind it is provisioned,
// unlocked or recovered by the session module; nothing here shows a
// Bonsai account id, a key, a nullifier or a proof. Everything is read
// from the node and from the wallet inside the proving worker; nothing is
// fixture data. Money is base units as decimal strings until the moment it
// is formatted for a human.
//
// Shape: a product shell. A sidebar with the sections (overview, payment
// links, incoming, activity, settings) and the wallet at the bottom; a main
// column with a page head and cards. Money actions open as full pages with
// a form on them rather than as dialogs, and the page never repaints under
// a form the person has started filling in.
import QRCode from 'qrcode';
import type { LinksAccount, NamespaceInfo, PaymentRequest, WalletView } from 'peal-links';
import { claimTestFunds, depositOnChain, ensureGas, LinksApiError, testFundsSource, tokenBalance, withdrawOnChain } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, onAuthChange, resumeInjected, session } from '../auth';
import { connectorChoices, connectorLine } from '../links/connectors';
import { esc } from '../util';
import { describeError, formatUnits, fmtTime, parseUnits, shortHex } from '../links/format';
import {
  acknowledgeRecoveryCode,
  activate,
  client,
  disconnect,
  ensureWalletChain,
  links,
  loadStatus,
  lockAccount,
  onLinksChange,
  payAddress,
  recoverWithCode,
  rename,
  restoreFile,
  resumeSignIn,
  selectNamespace,
  setAutoClaim,
} from '../links/session';
import '../links.css';

type Cleanup = () => void;

// ---- page-local state ---------------------------------------------------

/** The sections in the sidebar, and the pages that open from them. */
type Tab = 'overview' | 'links' | 'incoming' | 'activity' | 'settings' | 'new-link' | 'link-created' | 'send' | 'fund' | 'withdraw' | 'mint' | 'rename' | 'restore';

const SECTIONS: Array<{ tab: Tab; label: string; icon: string }> = [
  { tab: 'overview', label: 'Overview', icon: 'home' },
  { tab: 'links', label: 'Payment links', icon: 'link' },
  { tab: 'incoming', label: 'Incoming', icon: 'inbox' },
  { tab: 'activity', label: 'Activity', icon: 'activity' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

/** Which section a page belongs to, for the sidebar highlight and the back button. */
const PARENT: Record<Tab, Tab> = {
  overview: 'overview',
  links: 'links',
  incoming: 'incoming',
  activity: 'activity',
  settings: 'settings',
  'new-link': 'links',
  'link-created': 'links',
  send: 'overview',
  fund: 'overview',
  withdraw: 'overview',
  mint: 'overview',
  rename: 'settings',
  restore: 'settings',
};

interface PageState {
  tab: Tab;
  view: WalletView | null;
  labels: Record<string, string>;
  displayName: string | null;
  recovery: string | null;
  requests: PaymentRequest[];
  busy: string | null; // a running operation, shown as status
  error: string | null;
  notice: string | null;
  lastLink: { request: PaymentRequest; url: string; qr: string } | null;
  /** An address that has not activated private receiving (invitation). */
  invite: string | null;
  walletTokenBalance: string | null;
  withdrawals: Array<{ position: number; amount: string; recipient: string; status: string; tx_hash: string | null }>;
}

const initial = (): PageState => ({
  tab: 'overview',
  view: null,
  labels: {},
  displayName: null,
  recovery: null,
  requests: [],
  busy: null,
  error: null,
  notice: null,
  lastLink: null,
  invite: null,
  walletTokenBalance: null,
  withdrawals: [],
});

let page: PageState = initial();

function requestUrl(id: string): string {
  return `${location.origin}/pay/${id}`;
}

function inviteUrl(address: string): string {
  return `${location.origin}/#/bonsai?invite=${address.toLowerCase()}`;
}

// ---- small pieces -----------------------------------------------------------

const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-7A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  wallet: '<path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/><path d="M18 13h-2a1 1 0 0 0 0 2h2a1 1 0 0 0 0-2z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
};

function icon(name: string): string {
  return `<svg class="pla-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
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

function unreachable(err: string): string {
  return `
    <div class="pl-notice pl-notice-warn">
      <strong>Services are not running.</strong> ${esc(err)}. Start the local stack and reload:
      <pre class="pl-code">scripts/peal-links/stack.sh up</pre>
    </div>`;
}

/** A form field: label, help line, control. */
function field(label: string, control: string, help = '', extra = ''): string {
  return `<label class="pla-field${extra}"><span class="pla-label">${label}</span>${help ? `<span class="pla-help">${help}</span>` : ''}${control}</label>`;
}

function input(attrs: string, suffix = ''): string {
  return suffix
    ? `<span class="pla-input-wrap"><input class="pla-input" ${attrs}><span class="pla-input-suffix">${suffix}</span></span>`
    : `<input class="pla-input" ${attrs}>`;
}

/** Radio cards, as the reference design draws a choice between a few options. */
function choices(name: string, options: Array<{ value: string; title: string; hint: string; checked?: boolean }>): string {
  return `<div class="pla-choices" role="radiogroup">${options
    .map(
      (o) =>
        `<label class="pla-choice"><input type="radio" name="${name}" value="${esc(o.value)}" ${o.checked ? 'checked' : ''}><span class="pla-choice-dot"></span><span class="pla-choice-text"><b>${esc(o.title)}</b><i>${esc(o.hint)}</i></span></label>`,
    )
    .join('')}</div>`;
}

// ---- the shell --------------------------------------------------------------

function sidebar(): string {
  const l = links();
  const evm = session();
  const active = PARENT[page.tab];
  const nsSelect =
    l.status && l.status.namespaces.length > 1
      ? `<label class="pla-ns"><span class="pla-ns-label">network</span><select class="pla-select" id="pl-ns">${l.status.namespaces.map((n) => `<option value="${esc(n.id)}" ${n.id === l.namespace!.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select></label>`
      : l.namespace
        ? `<div class="pla-ns"><span class="pla-ns-label">network</span><span class="pla-ns-one">${esc(l.namespace.label)}</span></div>`
        : '';
  const wallet = !evm.address
    ? `<div class="pla-wallet pla-wallet-off"><span class="pla-wallet-line">${icon('wallet')} no wallet connected</span></div>`
    : `<div class="pla-wallet">
        <span class="pla-wallet-line">${connectorLine()}</span>
        ${l.account ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>private payments on</span>` : `<span class="pl-status"><span class="pl-status-dot"></span>account locked</span>`}
        <div class="pla-wallet-actions">
          ${l.account ? `<button type="button" class="pla-btn pla-btn-sm" id="pl-lock" title="lock the private account on this device">${icon('lock')} Lock</button>` : ''}
          <button type="button" class="pla-btn pla-btn-sm" id="pl-disconnect" title="${evm.source === 'privy' ? 'log out of Privy and lock the account on this device' : 'forget this browser wallet and lock the account on this device'}">${icon('out')} Disconnect</button>
        </div>
      </div>`;
  return `
    <aside class="pla-side">
      <a class="pla-brand" href="#/bonsai"><span class="pla-brand-dot"></span><span>Peal Links</span></a>
      ${nsSelect}
      <nav class="pla-nav" aria-label="sections">
        ${SECTIONS.map((s) => `<button type="button" class="pla-nav-item${active === s.tab ? ' is-active' : ''}" data-tab="${s.tab}" ${active === s.tab ? 'aria-current="page"' : ''}>${icon(s.icon)}<span>${s.label}</span></button>`).join('')}
      </nav>
      ${wallet}
      <a class="pla-home" href="#/">${icon('back')} Peal Network</a>
    </aside>`;
}

function head(title: string, sub: string, actions = '', back: Tab | null = null): string {
  return `
    <div class="pla-head">
      <div class="pla-head-l">
        ${back ? `<button type="button" class="pla-back" data-tab="${back}" aria-label="back">${icon('back')}</button>` : ''}
        <div><h1 class="pla-title">${title}</h1><p class="pla-sub">${sub}</p></div>
      </div>
      ${actions ? `<div class="pla-head-r">${actions}</div>` : ''}
    </div>`;
}

function notices(): string {
  const l = links();
  return `
    ${page.error ? `<div class="pl-notice pl-notice-bad" role="alert">${esc(page.error)}</div>` : ''}
    ${page.notice ? `<div class="pl-notice" role="status">${esc(page.notice)}</div>` : ''}
    ${page.busy ? `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(page.busy)}</span></div>` : ''}
    ${l.paramsProgress ? `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(l.paramsProgress)}</span></div>` : ''}
    ${recoveryCodeBanner()}
    ${invitePanel()}`;
}

function recoveryCodeBanner(): string {
  const code = links().newRecoveryCode;
  if (!code) return '';
  return `
    <div class="pl-notice pl-notice-warn" role="alert">
      <strong>Save your recovery code now.</strong> Your wallet cannot derive a recovery key, so this code protects the backup of your private account. It is shown once and Peal never stores it; without it, a new browser cannot recover your balance.
      <div class="pl-share-link" style="margin-top:10px"><input class="pl-input pl-mono" readonly value="${esc(code)}" id="pl-code"><button type="button" class="pla-btn" data-copy="${esc(code)}">Copy</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pla-btn pla-btn-dark" id="pl-code-saved">I saved it</button></div>
    </div>`;
}

function invitePanel(): string {
  if (!page.invite) return '';
  const url = inviteUrl(page.invite);
  return `
    <div class="pl-notice pl-notice-warn" role="status" id="pl-invite">
      <strong>${esc(shortHex(page.invite, 6, 4))} has not activated private receiving on Peal Links yet.</strong> No funds were moved. Send them this invitation; once they connect their wallet and continue, you can pay them privately.
      <div class="pl-share-link" style="margin-top:10px"><input class="pl-input" readonly value="${esc(url)}" id="pl-invite-url"><button type="button" class="pla-btn" data-copy="${esc(url)}">Copy invitation</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pla-btn" id="pl-invite-close">Close</button></div>
    </div>`;
}

// ---- onboarding: connect, continue, recover ---------------------------------

function onboarding(): string {
  const l = links();
  const evm = session();
  if (!evm.address) {
    return `
      ${head('Welcome to Peal Links', 'Your existing wallet is your payment identity here. Peal keeps a private account behind it.')}
      ${notices()}
      <div class="pla-card pla-card-narrow">
        <div class="pla-card-body">
          <p class="pla-p">Payments between Peal users hide the amount and the parties. Deposits and withdrawals are public on the chain, like any token transfer. Nothing to install, no second address to manage.</p>
          ${connectorChoices('pl')}
        </div>
      </div>`;
  }
  let body: string;
  switch (l.setup) {
    case 'signing-in':
    case 'checking':
    case 'setting-up':
    case 'recovery-signature':
      body = `<div class="pl-notice" role="status"><span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(l.setupDetail ?? 'working')}</span></div>`;
      break;
    case 'needs-recovery-code':
      body = `
        <p class="pla-p">This wallet already has private payments on Peal Links. Its backup is protected by the recovery code you saved when you set it up.</p>
        <form id="pl-recovery-code" class="pla-form">
          ${field('Recovery code', input('name="code" required autocomplete="off" placeholder="PEAL-XXXXX-XXXXX-XXXXX-XXXXX"'))}
          <div class="pla-form-actions"><button type="submit" class="pla-btn pla-btn-dark pla-btn-block">Open my account</button><button type="button" class="pla-btn pla-btn-block" data-tab="restore">Import a backup file instead</button></div>
        </form>`;
      break;
    case 'no-backup':
      body = `
        <div class="pl-notice pl-notice-warn">${esc(l.setupDetail ?? 'no backup is stored for this wallet')}</div>
        <div class="pla-form-actions"><button type="button" class="pla-btn pla-btn-block" data-tab="restore">Import a backup file</button></div>`;
      break;
    default:
      body = `
        <p class="pla-p">${l.hasStoredAccount ? 'Your private account is on this device. Continue to unlock it; no signature is needed.' : 'First time here: your wallet will confirm one Peal Links message that authorizes a private account for it, and one recovery message so the account can be recovered from any device.'}</p>
        ${l.setupDetail ? `<div class="pl-notice pl-notice-warn">${esc(l.setupDetail)}</div>` : ''}
        <div class="pla-form-actions"><button type="button" class="pla-btn pla-btn-dark pla-btn-block" id="pl-activate">Continue with this wallet</button><button type="button" class="pla-btn pla-btn-block" data-tab="restore">Import a backup file</button></div>`;
  }
  if (page.tab === 'restore') return restorePage();
  return `
    ${head('Private payments', `Wallet ${esc(shortHex(evm.address, 6, 4))} is connected. One step to open its private account.`)}
    ${notices()}
    <div class="pla-card pla-card-narrow"><div class="pla-card-body">${body}</div></div>`;
}

// ---- overview -------------------------------------------------------------

function stats(): string {
  const ns = links().namespace!;
  const v = page.view;
  const demo = ns.environment !== 'mainnet';
  const avail = formatUnits(v?.balance ?? '0', ns.decimals);
  const incoming = formatUnits(v?.unclaimed ?? '0', ns.decimals);
  const wallet = page.walletTokenBalance !== null ? formatUnits(page.walletTokenBalance, ns.decimals) : null;
  return `
    <div class="pla-stats pl-balances">
      <div class="pla-stat pl-balance pla-stat-primary">
        <span class="pla-stat-label">private balance</span>
        <span class="pla-stat-amount pl-balance-amount">${avail}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></span>
        <span class="pla-stat-sub">spendable now · only you can see it</span>
      </div>
      <div class="pla-stat pl-balance">
        <span class="pla-stat-label">incoming</span>
        <span class="pla-stat-amount pl-balance-amount">${incoming}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></span>
        <span class="pla-stat-sub">verified, not yet claimed${v && v.unclaimed !== '0' ? ` · <button type="button" class="pla-link" data-tab="incoming">claim</button>` : ''}</span>
      </div>
      <div class="pla-stat pl-balance">
        <span class="pla-stat-label">wallet balance${demo ? ` <span class="pla-badge">${esc(ns.environment)} funds</span>` : ''}</span>
        <span class="pla-stat-amount pl-balance-amount">${wallet ?? '—'}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></span>
        <span class="pla-stat-sub">public on ${esc(ns.chain_name)}${testFundsLink(ns)}</span>
      </div>
    </div>`;
}

/** On a test namespace, where to get the asset: a button the app can act
 * on, or a link to an external faucet. */
function testFundsLink(ns: NamespaceInfo): string {
  const src = testFundsSource(ns);
  if (!src || !session().address) return '';
  if (src.kind === 'external') return ` · <a class="pla-link" href="${esc(src.url)}" target="_blank" rel="noreferrer">get testnet ${esc(ns.token_symbol)}</a>`;
  return ` · <button type="button" class="pla-link" id="pl-test-funds">get test ${esc(ns.token_symbol)}</button>`;
}

function quickActions(): string {
  const l = links();
  const devMint = !!l.status?.dev_mint;
  const nsAvail = !!l.namespace?.available;
  const hasWallet = !!session().address;
  const canSettle = nsAvail && l.status?.signer_mode !== 'none';
  return `
    <div class="pla-quick">
      <button type="button" class="pla-quick-item" data-tab="new-link">${icon('plus')}<b>New payment link</b><i>a fixed amount anyone can pay you privately</i></button>
      <button type="button" class="pla-quick-item" data-tab="send">${icon('send')}<b>Send to an address</b><i>pay a wallet that uses Peal Links</i></button>
      ${
        nsAvail
          ? `<button type="button" class="pla-quick-item" data-tab="fund" ${hasWallet ? '' : 'disabled'}>${icon('down')}<b>Add funds</b><i>deposit from your wallet, public on ${esc(l.namespace!.chain_name)}</i></button>`
          : devMint
            ? `<button type="button" class="pla-quick-item" data-tab="mint">${icon('down')}<b>Add test funds</b><i>development fixture, no chain deposit</i></button>`
            : `<button type="button" class="pla-quick-item" disabled>${icon('down')}<b>Add funds</b><i>deposits are not available on this network</i></button>`
      }
      ${
        canSettle
          ? `<button type="button" class="pla-quick-item" data-tab="withdraw" ${hasWallet ? '' : 'disabled'}>${icon('up')}<b>Withdraw</b><i>to a wallet on ${esc(l.namespace!.chain_name)}</i></button>`
          : `<button type="button" class="pla-quick-item" disabled>${icon('up')}<b>Withdraw</b><i>withdrawals are not available on this network</i></button>`
      }
    </div>`;
}

function overview(): string {
  const ns = links().namespace!;
  const v = page.view;
  const name = page.displayName ?? shortHex(session().address ?? '', 6, 4);
  const recentIn = (v?.receipts ?? []).slice(-4).reverse();
  const recentAct = (v?.history ?? []).slice(-5).reverse();
  return `
    ${head('Overview', `${esc(name)} · your private balance and what happened lately, on ${esc(ns.label)}.`)}
    ${notices()}
    ${stats()}
    ${quickActions()}
    <div class="pla-two">
      <div class="pla-card">
        <div class="pla-card-head"><h2 class="pla-card-title">incoming</h2><button type="button" class="pla-link" data-tab="incoming">view all</button></div>
        ${recentIn.length ? `<ul class="pla-list">${recentIn.map((r) => receiptRow(r, v!.receipts.indexOf(r))).join('')}</ul>` : `<div class="pla-empty">Payments addressed to you appear here as soon as they reach you.</div>`}
      </div>
      <div class="pla-card">
        <div class="pla-card-head"><h2 class="pla-card-title">activity</h2><button type="button" class="pla-link" data-tab="activity">view all</button></div>
        ${recentAct.length ? `<ul class="pla-list">${recentAct.map(historyRow).join('')}</ul>` : `<div class="pla-empty">Deposits, payments sent and received, and withdrawals appear here.</div>`}
      </div>
    </div>
    ${ledgerLine()}`;
}

function ledgerLine(): string {
  const s = links().status!;
  const ns = links().namespace!;
  const led = s.ledgers.find((l) => l.namespace === ns.id);
  return `<p class="pla-foot">${s.setup === 'local-dev' ? `<strong>Local development setup.</strong> proving keys generated locally (no ceremony), balances in ${esc(ns.environment)} funds · ` : ''}ledger ${esc(s.ledger_mode)}${s.consensus ? ` · height ${s.consensus.height}` : ''}${led ? ` · ${led.receipt_count} receipts · state <span class="pl-mono">${esc(led.state_root.slice(0, 12))}…</span>` : ''} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></p>`;
}

// ---- lists ---------------------------------------------------------------------

function receiptRow(r: WalletView['receipts'][number], idx: number): string {
  const ns = links().namespace!;
  const what = r.sender === MINT_SENDER ? 'deposit from your wallet' : 'private payment';
  const ref = r.reference && /^[a-z2-7]{24}$/.test(r.reference) ? `for link ${esc(r.reference.slice(0, 8))}…` : r.reference ? esc(r.reference) : '';
  return `<li class="pla-row">
    <span class="pla-row-ic pla-row-ic-in">${icon('down')}</span>
    <span class="pla-row-main"><b>${what}</b><i>${receiptStatus(r.status)} · ${esc(fmtTime(r.discovered_at))}${ref ? ` · ${ref}` : ''}</i></span>
    <span class="pla-row-side"><b>+${formatUnits(r.amount, ns.decimals)} ${esc(ns.token_symbol)}</b>${r.status === 'unclaimed' ? `<button type="button" class="pla-btn pla-btn-sm" data-claim="${idx}">claim now</button>` : ''}</span>
  </li>`;
}

function historyRow(h: WalletView['history'][number]): string {
  const ns = links().namespace!;
  const to = h.position !== null ? page.labels[String(h.position)] : undefined;
  const main =
    h.kind === 'send'
      ? h.reference?.startsWith('withdraw:')
        ? `withdrew to ${esc(shortHex(h.reference.slice('withdraw:'.length), 6, 4))}`
        : to
          ? `sent to ${esc(shortHex(to, 6, 4))}`
          : h.reference && /^[a-z2-7]{24}$/.test(h.reference)
            ? `paid link ${esc(h.reference.slice(0, 8))}…`
            : 'sent privately'
      : h.counterparty === MINT_SENDER
        ? 'deposit claimed'
        : 'received privately';
  const out = h.kind === 'send';
  return `<li class="pla-row">
    <span class="pla-row-ic ${out ? 'pla-row-ic-out' : 'pla-row-ic-in'}">${icon(out ? 'up' : 'down')}</span>
    <span class="pla-row-main"><b>${main}</b><i>${esc(fmtTime(h.at))}</i></span>
    <span class="pla-row-side"><b class="${out ? 'pla-neg' : ''}">${out ? '−' : '+'}${formatUnits(h.amount, ns.decimals)} ${esc(ns.token_symbol)}</b></span>
  </li>`;
}

function linksPage(): string {
  const ns = links().namespace!;
  const rows = page.requests
    .map((r) => {
      const m = r.manifest;
      return `<li class="pla-row">
        <span class="pla-row-ic">${icon('link')}</span>
        <span class="pla-row-main"><b>${esc(m.title)}</b><i>${statusChip(r.status)} · ${esc(fmtTime(m.created_at))}${m.reference ? ` · ${esc(m.reference)}` : ''}</i></span>
        <span class="pla-row-side"><b>${formatUnits(m.amount, ns.decimals)} ${esc(ns.token_symbol)}</b><span class="pla-row-tools"><button type="button" class="pla-link" data-copy="${esc(requestUrl(m.request_id))}">copy link</button><a class="pla-link" href="#/pay/${esc(m.request_id)}">open</a>${r.status === 'active' ? `<button type="button" class="pla-link" data-archive="${esc(m.request_id)}">archive</button>` : ''}</span></span>
      </li>`;
    })
    .join('');
  return `
    ${head('Payment links', 'A link is a fixed amount in one asset that anyone can pay you privately, once.', `<button type="button" class="pla-btn pla-btn-dark" data-tab="new-link">${icon('plus')} New payment link</button>`)}
    ${notices()}
    <div class="pla-card">
      ${rows ? `<ul class="pla-list">${rows}</ul>` : `<div class="pla-empty pla-empty-tall"><b>No payment links yet.</b><span>Create one, share it, and the payment arrives in your private balance.</span></div>`}
    </div>`;
}

function incomingPage(): string {
  const v = page.view!;
  const rows = v.receipts
    .slice()
    .reverse()
    .map((r) => receiptRow(r, v.receipts.indexOf(r)))
    .join('');
  const l = links();
  return `
    ${head('Incoming', 'Payments addressed to you. Claiming adds them to your private balance.', `<label class="pla-switch"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}><span class="pla-switch-track"></span><span>claim automatically while this page is open</span></label>`)}
    ${notices()}
    <div class="pla-card">
      ${rows ? `<ul class="pla-list">${rows}</ul>` : `<div class="pla-empty pla-empty-tall"><b>Nothing incoming.</b><span>Payments appear here as soon as they reach you, even if you were offline when they were made.</span></div>`}
    </div>`;
}

function activityPage(): string {
  const ns = links().namespace!;
  const v = page.view!;
  const rows = v.history.slice().reverse().map(historyRow).join('');
  const wd = page.withdrawals.length
    ? `<div class="pla-card">
        <div class="pla-card-head"><h2 class="pla-card-title">withdrawals</h2></div>
        <ul class="pla-list">${page.withdrawals
          .map(
            (w) => `<li class="pla-row"><span class="pla-row-ic pla-row-ic-out">${icon('up')}</span><span class="pla-row-main"><b>to ${esc(shortHex(w.recipient, 6, 4))}</b><i>${w.status === 'confirmed' ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>confirmed on chain</span>` : `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(w.status.replace('_', ' '))}</span>`}${w.tx_hash ? ` · tx <span class="pl-mono">${esc(shortHex(w.tx_hash, 8, 6))}</span>` : ''}</i></span><span class="pla-row-side"><b>${formatUnits(w.amount, ns.decimals)} ${esc(ns.token_symbol)}</b></span></li>`,
          )
          .join('')}</ul>
      </div>`
    : '';
  return `
    ${head('Activity', 'Everything this account did, decrypted on this device. The chain never gets this list.', `<button type="button" class="pla-btn" id="pl-export-csv" title="a plaintext file of this account's receipts and payments">Export CSV</button>`)}
    ${notices()}
    <div class="pla-card">
      ${rows ? `<ul class="pla-list">${rows}</ul>` : `<div class="pla-empty pla-empty-tall"><b>No activity yet.</b><span>Deposits, payments sent and received, and withdrawals appear here.</span></div>`}
    </div>
    ${wd}`;
}

function settingsPage(): string {
  const l = links();
  const s = l.status!;
  const evm = session();
  return `
    ${head('Settings', 'Your name on links, recovery, backups and this device.')}
    ${notices()}
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">profile</h2></div>
      <div class="pla-setting"><div><b>Display name</b><i>${esc(page.displayName ?? shortHex(evm.address ?? '', 6, 4))} · shown next to your wallet address on your links; a name you chose, not an identity check</i></div><button type="button" class="pla-btn" data-tab="rename">Change display name</button></div>
      <div class="pla-setting"><div><b>Wallet</b><i>${connectorLine()} · the only identity anyone sees</i></div></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">recovery and backups</h2></div>
      <div class="pla-setting"><div><b>Recovery</b><i>${page.recovery === 'wallet-signature' ? 'your wallet signature opens your backup on any device' : 'your recovery code opens your backup on any device'}; the backup is kept encrypted by the node and Peal cannot open it</i></div></div>
      <div class="pla-setting"><div><b>Backup file</b><i>an encrypted copy of your private account, for a device that cannot reach the node's backup</i></div><div class="pla-setting-actions"><button type="button" class="pla-btn" id="pl-backup">Export backup file</button><button type="button" class="pla-btn" data-tab="restore">Import a backup file</button></div></div>
      <div class="pla-setting"><div><b>History export</b><i>a plaintext CSV of your payments; anyone with the file learns exactly that</i></div><button type="button" class="pla-btn" id="pl-export-csv">Export CSV</button></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">this device</h2></div>
      <div class="pla-setting"><div><b>Claim incoming automatically</b><i>while this page is open, incoming payments are proved and claimed by themselves</i></div><label class="pla-switch"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}><span class="pla-switch-track"></span></label></div>
      <div class="pla-setting"><div><b>Lock</b><i>closes the private account on this device; reconnecting the same wallet unlocks it with no signature</i></div><button type="button" class="pla-btn" id="pl-lock">Lock</button></div>
      <div class="pla-setting"><div><b>Disconnect</b><i>${evm.source === 'privy' ? 'logs out of Privy and locks the account on this device' : 'forgets this browser wallet and locks the account on this device'}</i></div><button type="button" class="pla-btn" id="pl-disconnect">Disconnect</button></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">network</h2></div>
      ${s.setup === 'local-dev' ? `<div class="pla-setting"><div><b>Local development setup</b><i>proving keys generated locally (no ceremony), ledger in ${esc(s.ledger_mode)} mode, balances in ${esc(l.namespace!.environment)} funds. This is the demo's trust model, stated plainly.</i></div></div>` : ''}
      ${s.ledgers
        .map((led) => {
          const ns = s.namespaces.find((n) => n.id === led.namespace);
          return `<div class="pla-setting"><div><b>${esc(ns?.label ?? led.namespace.slice(0, 12))}</b><i>${led.receipt_count} receipts · seq ${led.seq} · state root <span class="pl-mono">${esc(led.state_root.slice(0, 16))}…</span></i></div></div>`;
        })
        .join('')}
      <div class="pla-setting"><div><b>Ledger</b><i>${esc(s.ledger_mode)}${s.consensus ? ` · height ${s.consensus.height} · state <span class="pl-mono">${esc(s.consensus.state_root.slice(0, 12))}…</span>` : ''} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></i></div></div>
    </div>`;
}

// ---- form pages --------------------------------------------------------------

function newLinkPage(): string {
  const ns = links().namespace!;
  return `
    ${head('New payment link', 'A fixed amount in one asset. Anyone with the link can pay it, once.', '', 'links')}
    ${notices()}
    <form id="pl-request-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-head"><h2 class="pla-card-title">request details</h2></div>
      <div class="pla-card-body">
        ${field('What is it for', input('name="title" maxlength="140" required placeholder="Logo files, final"'), 'Shown to the payer on the link.')}
        ${field('Amount', input(`name="amount" inputmode="decimal" required placeholder="0.00"`, esc(ns.token_symbol)), `${esc(ns.token_symbol)} on ${esc(ns.chain_name)}. The exact amount; the link can be paid once.`)}
        ${field('Reference', input('name="reference" maxlength="64" placeholder="INV-0417"'), 'Optional. An invoice number or a note, shown on the link.')}
      </div>
      <div class="pla-card-head"><h2 class="pla-card-title">expiry</h2></div>
      <div class="pla-card-body">
        ${choices('expiry', [
          { value: '', title: 'No expiry', hint: 'stays payable until you archive it', checked: true },
          { value: '86400', title: '24 hours', hint: 'expires this time tomorrow' },
          { value: '604800', title: '7 days', hint: 'a week from now' },
          { value: '2592000', title: '30 days', hint: 'a month from now' },
        ])}
        <p class="pla-note">The title, amount, your display name and your wallet address are visible to anyone holding the link. Keep sensitive details out of them.</p>
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="links">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Create link</button></div>
    </form>`;
}

function linkCreatedPage(): string {
  const l = page.lastLink;
  if (!l) return linksPage();
  const ns = links().namespace!;
  return `
    ${head('Your payment link', `${esc(l.request.manifest.title)} · ${formatUnits(l.request.manifest.amount, ns.decimals)} ${esc(ns.token_symbol)}`, '', 'links')}
    ${notices()}
    <div class="pla-card pla-card-narrow">
      <div class="pla-card-body pla-center">
        <div class="pl-qr" aria-label="QR code of the payment link">${l.qr}</div>
        <div class="pl-share-link" style="margin-top:14px"><input class="pla-input" readonly value="${esc(l.url)}" id="pl-link-url"><button type="button" class="pla-btn" data-copy="${esc(l.url)}">${icon('copy')} Copy</button></div>
        <p class="pla-note">Send it any way you like. The payer needs nothing but a wallet; you can close this page and come back later.</p>
        <button type="button" class="pla-btn pla-btn-dark pla-btn-block" data-tab="links" data-done>Done</button>
      </div>
    </div>`;
}

function sendPage(): string {
  const ns = links().namespace!;
  return `
    ${head('Send to an address', 'Pay a wallet that uses Peal Links. The amount and the parties stay private.', '', 'overview')}
    ${notices()}
    <form id="pl-send-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Recipient wallet address', input('name="to" required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" spellcheck="false" autocomplete="off"', ''), `On ${esc(ns.chain_name)}. Their receiving details are looked up and checked against their wallet's signature on this device.`, ' pla-field-mono')}
        ${field('Amount', input('name="amount" inputmode="decimal" required placeholder="0.00"', esc(ns.token_symbol)), page.view ? `Available: ${formatUnits(page.view.balance, ns.decimals)} ${esc(ns.token_symbol)}.` : '')}
        ${field('Note for the recipient', input('name="reference" maxlength="64" placeholder="thanks for lunch"'), 'Optional. Travels inside the encrypted receipt; the chain never sees it.')}
        <p class="pla-note">Your wallet confirms the payment; nothing else leaves your browser but the proof and an encrypted receipt.</p>
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="overview">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Continue</button></div>
    </form>`;
}

function fundPage(): string {
  const ns = links().namespace!;
  const evm = session();
  const wallet = page.walletTokenBalance !== null ? formatUnits(page.walletTokenBalance, ns.decimals) : null;
  return `
    ${head('Add funds', `A deposit of ${esc(ns.token_symbol)} from your wallet into the gateway on ${esc(ns.chain_name)}.`, '', 'overview')}
    ${notices()}
    <form id="pl-fund-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Amount', input('name="amount" inputmode="decimal" required placeholder="0.00"', esc(ns.token_symbol)), `From wallet <span class="pl-mono">${esc(shortHex(evm.address ?? '', 6, 4))}</span>${wallet !== null ? `, which holds ${esc(wallet)} ${esc(ns.token_symbol)}` : ''}.`)}
        <div class="pla-steps">
          <div class="pla-step"><b>1</b><span>Your wallet approves the amount</span></div>
          <div class="pla-step"><b>2</b><span>Your wallet sends the deposit</span></div>
          <div class="pla-step"><b>3</b><span>Credited after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}, then claimed into your private balance</span></div>
        </div>
        <p class="pla-note">The amount and your address are visible on ${esc(ns.chain_name)}, like any token transfer. What happens inside Peal afterwards is not.</p>
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="overview">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Deposit from wallet</button></div>
    </form>`;
}

function withdrawPage(): string {
  const ns = links().namespace!;
  const s = links().status!;
  const v = page.view;
  return `
    ${head('Withdraw', `Move funds from your private balance to a wallet on ${esc(ns.chain_name)}.`, '', 'overview')}
    ${notices()}
    <form id="pl-withdraw-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Amount', input('name="amount" inputmode="decimal" required placeholder="0.00"', esc(ns.token_symbol)), v ? `Available: ${formatUnits(v.balance, ns.decimals)} ${esc(ns.token_symbol)}.` : '')}
        ${field('To wallet address', input(`name="recipient" required pattern="0x[0-9a-fA-F]{40}" value="${esc(session().address ?? '')}" spellcheck="false" autocomplete="off"`), 'Your connected wallet by default; it confirms the release.', ' pla-field-mono')}
        <div class="pla-steps">
          <div class="pla-step"><b>1</b><span>The amount leaves your private balance with a proof</span></div>
          <div class="pla-step"><b>2</b><span>${s.signer_threshold} of ${s.signers.length} settlement signers attest to the release</span></div>
          <div class="pla-step"><b>3</b><span>Your wallet confirms, and the gateway pays the recipient</span></div>
        </div>
        <p class="pla-note">This is a committee-attested bridge${s.signer_mode === 'single-process-fixture' ? ' and, on this node, the signers are a single-process fixture' : s.signer_mode === 'one-key-per-validator' ? ' and, on this stack, each local validator process holds one signer key' : ''}: a compromised committee could release funds wrongly. The withdrawal, its amount and the recipient are public on the chain.</p>
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="overview">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Withdraw</button></div>
    </form>`;
}

function mintPage(): string {
  const ns = links().namespace!;
  return `
    ${head('Add test funds', 'A development fixture: credits a deposit without a chain deposit.', '', 'overview')}
    ${notices()}
    <form id="pl-mint-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        <p class="pla-note">This node runs with the labelled dev-mint endpoint. The intent, its proof and the claim are real; only the on-chain leg is stood in for. It does not exist on any deployment with real funds.</p>
        ${field('Amount', input('name="amount" inputmode="decimal" required value="100"', esc(ns.token_symbol)))}
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="overview">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Credit test funds</button></div>
    </form>`;
}

function renamePage(): string {
  return `
    ${head('Display name', 'Shown next to your wallet address on your payment links.', '', 'settings')}
    ${notices()}
    <form id="pl-rename-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Display name', input(`name="display" maxlength="60" required value="${esc(page.displayName ?? '')}"`), 'A name you chose, not an identity check. Your wallet confirms the change.')}
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="settings">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Save</button></div>
    </form>`;
}

function restorePage(): string {
  const back: Tab = links().account ? 'settings' : 'overview';
  return `
    ${head('Import a backup file', 'A file exported from Peal Links, protected by the recovery code chosen when exporting it.', '', back)}
    ${notices()}
    <form id="pl-restore" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Backup file', input('type="file" name="file" accept="application/json,.json" required'))}
        ${field('Recovery code', input('name="code" required autocomplete="off"'), 'The code you chose when the file was exported.', ' pla-field-mono')}
        <p class="pla-note">After importing, the account is checked against the ledger; a backup older than your last operation is reported as stale rather than used.</p>
      </div>
      <div class="pla-form-foot"><button type="button" class="pla-btn" data-tab="${back}">Cancel</button><button type="submit" class="pla-btn pla-btn-dark">Import</button></div>
    </form>`;
}

// ---- the page ------------------------------------------------------------------

const MINT_SENDER_KEY = 'peal-links:mint-sender';
let MINT_SENDER = '';

function main(): string {
  const l = links();
  if (!l.account || !page.view) return onboarding();
  switch (page.tab) {
    case 'links':
      return linksPage();
    case 'incoming':
      return incomingPage();
    case 'activity':
      return activityPage();
    case 'settings':
      return settingsPage();
    case 'new-link':
      return newLinkPage();
    case 'link-created':
      return linkCreatedPage();
    case 'send':
      return sendPage();
    case 'fund':
      return fundPage();
    case 'withdraw':
      return withdrawPage();
    case 'mint':
      return mintPage();
    case 'rename':
      return renamePage();
    case 'restore':
      return restorePage();
    default:
      return overview();
  }
}

function html(): string {
  const l = links();
  if (l.statusError || !l.status || !l.namespace) {
    return `<div class="pl pla"><div class="pla-shell"><div class="pla-main">${head('Peal Links', 'payments')}${l.statusError ? unreachable(l.statusError) : `<div class="skeleton-row"><span class="skeleton" style="width:240px"></span></div>`}</div></div></div>`;
  }
  return `
    <div class="pl pla">
      <div class="pla-shell">
        ${sidebar()}
        <div class="pla-main" data-view="${page.tab}">${main()}</div>
      </div>
    </div>`;
}

// ---- behaviour ---------------------------------------------------------------

export function renderBonsaiApp(root: HTMLElement): Cleanup {
  const previousTitle = document.title;
  document.title = 'Peal Links. payments';
  document.body.classList.add('pla-page');
  let stale = false;
  let syncTimer = 0;
  let claiming = false;
  page = initial();
  MINT_SENDER = localStorage.getItem(MINT_SENDER_KEY) ?? '';
  // An invitation link (#/bonsai?invite=0x…) lands here: say what it is.
  const invited = /[?&]invite=(0x[0-9a-fA-F]{40})/.exec(location.hash);
  if (invited) page.notice = `Someone wants to pay you privately on Peal Links. Connect the wallet ${shortHex(invited[1]!, 6, 4)} and continue; they can pay you once your wallet has private receiving.`;

  /** Repaint. A form the person has started filling in is never replaced
   * under them (a picked file cannot be restored); the paint waits until
   * they leave it, unless `force` says the paint is the answer to what
   * they just did. */
  const paint = (force = false) => {
    if (stale) return;
    if (!force && root.querySelector('form[data-dirty]')) return;
    const active = document.activeElement as HTMLInputElement | null;
    const activeName = active?.name;
    const activeValue = active?.value;
    const y = window.scrollY;
    root.innerHTML = html();
    if (activeName) {
      const again = root.querySelector<HTMLInputElement>(`input[name="${activeName}"]`);
      if (again && activeValue !== undefined && again.type !== 'file' && again.type !== 'radio') {
        again.value = activeValue;
        again.focus();
      }
    }
    window.scrollTo({ top: y });
  };

  const go = (tab: Tab) => {
    page.tab = tab;
    page.error = null;
    paint(true);
    // The new view slides in once; routine repaints do not replay it.
    root.querySelector('.pla-main')?.classList.add('pla-enter');
    window.scrollTo({ top: 0 });
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
      page.requests = [];
      return;
    }
    page.view = await l.account.view();
    page.labels = await l.account.labels();
    const profile = await l.account.profile();
    page.displayName = profile?.display_name ?? null;
    page.recovery = profile?.recovery ?? null;
    // Withdrawals: every send whose reference is a withdraw marker.
    const burns = page.view.history.filter((h) => h.kind === 'send' && h.reference?.startsWith('withdraw:') && h.position !== null);
    const withdrawals = [];
    for (const b of burns) {
      try {
        const w = await client.withdrawal(l.namespace!.id, b.position!);
        withdrawals.push({ position: b.position!, amount: w.amount, recipient: w.recipient, status: w.status, tx_hash: w.tx_hash });
      } catch {
        withdrawals.push({ position: b.position!, amount: b.amount, recipient: b.reference!.slice('withdraw:'.length), status: 'not yet settled', tx_hash: null });
      }
    }
    page.withdrawals = withdrawals;
    if (l.signedIn) {
      try {
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
    paint(true);
    try {
      await f();
    } catch (e) {
      const ns = links().namespace;
      page.error = describeError(e, ns?.chain_name, ns?.chain_id);
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
        await run('claiming an incoming payment: proving on this device (about 7 s)', async () => {
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

  const doActivate = () =>
    run('setting up private payments for your wallet', async () => {
      const account = await activate();
      if (account) {
        const v = await account.view();
        if (v.pending) {
          const r = await account.reconcile();
          page.notice = `A ${v.pending} was pending from an earlier session: ${r === 'committed' ? 'the ledger had accepted it, recorded' : r === 'aborted' ? 'the ledger had not seen it, dropped' : r}.`;
        }
      }
    });

  // A form becomes "dirty" on the first keystroke or choice; the paint
  // guard above reads it.
  root.addEventListener('input', (ev) => {
    (ev.target as HTMLElement).closest('form')?.setAttribute('data-dirty', '');
  });

  root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button, a');
    if (!btn) return;
    const l = links();
    if (btn.dataset.tab) {
      if (btn.hasAttribute('data-done')) page.lastLink = null;
      go(btn.dataset.tab as Tab);
    } else if (btn.id === 'pl-login') session().login();
    else if (btn.id === 'pl-login-injected') void run('connecting browser wallet', async () => void (await connectInjected()));
    else if (btn.id === 'pl-activate') void doActivate();
    else if (btn.id === 'pl-test-funds') {
      const ns = l.namespace!;
      const evm = session();
      void run(`getting test ${ns.token_symbol} for your wallet`, async () => {
        await ensureWalletChain(ns);
        const how = await claimTestFunds(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address);
        await refreshWalletBalance();
        page.notice = how === 'chain-faucet' ? `${ns.chain_name} funded your wallet with ${ns.token_symbol}.` : `The test token's faucet sent 1,000 ${ns.token_symbol} to your wallet.`;
      });
    } else if (btn.id === 'pl-code-saved') {
      acknowledgeRecoveryCode();
      paint(true);
    } else if (btn.id === 'pl-lock') {
      lockAccount();
      page.view = null;
      page.tab = 'overview';
      paint(true);
    } else if (btn.id === 'pl-disconnect') {
      disconnect();
      page.view = null;
      page.requests = [];
      page.walletTokenBalance = null;
      page.tab = 'overview';
      paint(true);
    } else if (btn.id === 'pl-invite-close') {
      page.invite = null;
      paint(true);
    } else if (btn.id === 'pl-backup') {
      const code = prompt('Choose a recovery code for this file (at least 10 characters). You will need it to import the file.');
      if (!code || code.length < 10) return;
      void run('encrypting backup', async () => {
        const json = await l.account!.exportBackup(code);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `peal-links-backup-${l.namespace!.label.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        page.notice = 'Backup file exported. It contains your private account, encrypted under the code you chose: keep both somewhere safe.';
      });
    } else if (btn.id === 'pl-export-csv') {
      const ns = l.namespace!;
      const v = page.view!;
      const ok = confirm(
        'This writes a plaintext CSV of your payments (amounts, direction, positions, times) to a file on this device. Anyone who gets the file learns exactly that. Continue?',
      );
      if (!ok) return;
      const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
      const rows = [
        ['kind', 'amount', 'asset', 'to', 'position', 'reference', 'status', 'at'].map(q).join(','),
        ...v.history.map((h) =>
          [h.kind, `${h.kind === 'send' ? '-' : ''}${formatUnits(h.amount, ns.decimals)}`, ns.token_symbol, (h.position !== null && page.labels[String(h.position)]) || '', h.position ?? '', h.reference ?? '', 'settled', new Date(h.at * 1000).toISOString()].map((x) => q(String(x))).join(','),
        ),
        ...v.receipts
          .filter((r) => r.status !== 'claimed')
          .map((r) => ['incoming', formatUnits(r.amount, ns.decimals), ns.token_symbol, '', r.position, r.reference ?? '', r.status, new Date(r.discovered_at * 1000).toISOString()].map((x) => q(String(x))).join(',')),
      ];
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `peal-links-history-${ns.label.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (btn.dataset.copy) {
      void navigator.clipboard?.writeText(btn.dataset.copy).then(() => {
        const prev = btn.innerHTML;
        btn.textContent = 'copied';
        window.setTimeout(() => (btn.innerHTML = prev), 1200);
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
    }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'pl-autoclaim') {
      setAutoClaim((t as HTMLInputElement).checked);
      if ((t as HTMLInputElement).checked) void syncOnce();
    } else if (t.id === 'pl-ns') {
      const ns = links().status?.namespaces.find((n) => n.id === t.value);
      if (ns) void selectNamespace(ns).then(refresh).then(() => paint(true));
    } else {
      (t as HTMLElement).closest('form')?.setAttribute('data-dirty', '');
    }
  });

  const invalid = (msg: string) => {
    page.error = msg;
    paint(true);
  };

  root.addEventListener('submit', (ev) => {
    const form = ev.target as HTMLFormElement;
    ev.preventDefault();
    const data = new FormData(form);
    const l = links();
    if (form.id === 'pl-recovery-code') {
      void run('opening your backup with the recovery code', async () => {
        await recoverWithCode(String(data.get('code') ?? ''));
        page.notice = 'Your private account is back on this device.';
      });
    } else if (form.id === 'pl-restore') {
      const file = data.get('file') as File | null;
      if (!file) return;
      page.tab = l.account ? 'settings' : 'overview';
      void run('importing and checking against the ledger', async () => {
        const json = await file.text();
        const account = await restoreFile(json, String(data.get('code') ?? ''));
        const r = await account.reconcile();
        page.notice = r === 'conflict' ? 'Imported, but this backup is older than the account on the ledger. Do not use it to pay; import a newer backup.' : 'Imported from the backup file.';
      });
    } else if (form.id === 'pl-request-form') {
      const ns = l.namespace!;
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0') return invalid(`enter an amount with at most ${ns.decimals} decimals`);
      const expiryIn = Number(String(data.get('expiry') ?? '')) || 0;
      const expiresAt = expiryIn > 0 ? Math.floor(Date.now() / 1000) + expiryIn : null;
      page.tab = 'links';
      void run('signing and publishing the link', async () => {
        const request = await l.account!.createRequest({
          amount,
          title: String(data.get('title') ?? '').trim(),
          reference: String(data.get('reference') ?? '').trim() || null,
          expiresAt,
        });
        const url = requestUrl(request.manifest.request_id);
        const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        page.lastLink = { request, url, qr };
        page.tab = 'link-created';
      });
    } else if (form.id === 'pl-send-form') {
      const ns = l.namespace!;
      const to = String(data.get('to') ?? '').trim();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(to)) return invalid('enter a wallet address and an amount');
      page.invite = null;
      page.tab = 'overview';
      void run('looking the recipient up and verifying their receiving profile', async () => {
        const r = await payAddress(l.account!, to, amount, String(data.get('reference') ?? '').trim() || null, (stage) => {
          page.busy = stage === 'approve' ? 'confirm the payment in your wallet' : 'preparing the payment: proving on this device (about 7 s)';
          paint();
        });
        if ('unregistered' in r) {
          page.invite = to;
          return;
        }
        page.notice = `Sent ${formatUnits(amount, ns.decimals)} ${ns.token_symbol} to ${r.profile.display_name} (${shortHex(to, 6, 4)}). ${r.result.delivered ? 'They will see it when they are next online.' : 'The encrypted receipt is queued for delivery; the payment itself is complete.'}`;
      });
    } else if (form.id === 'pl-rename-form') {
      const name = String(data.get('display') ?? '').trim();
      if (!name) return;
      page.tab = 'settings';
      void run('confirm the new display name in your wallet', async () => {
        await rename(l.account!, name);
      });
    } else if (form.id === 'pl-fund-form') {
      const ns = l.namespace!;
      const evm = session();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !evm.address || !evm.provider) return invalid('enter an amount and connect a wallet');
      page.tab = 'overview';
      void run('adding funds: proving the deposit intent, then confirm the approval and the deposit in your wallet', async () => {
        await ensureWalletChain(ns);
        const { receipt } = await l.account!.prepareDeposit(amount);
        await ensureGas(ns, evm.address as Address);
        const tx = await depositOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, BigInt(amount), receipt);
        page.notice = `Deposit confirmed on ${ns.chain_name} (tx ${shortHex(tx.depositHash, 8, 6)}). It shows under incoming after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'} and becomes available once claimed.`;
      });
    } else if (form.id === 'pl-withdraw-form') {
      const ns = l.namespace!;
      const evm = session();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      const recipient = String(data.get('recipient') ?? '').trim();
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || !evm.address || !evm.provider) return invalid('enter an amount, a recipient address, and connect a wallet');
      page.tab = 'overview';
      void run('withdrawal: proving on this device (about 7 s), then the committee certificate, then confirm the release in your wallet', async () => {
        await ensureWalletChain(ns);
        const { certificate } = await l.account!.withdraw(amount, recipient);
        await ensureGas(ns, evm.address as Address);
        const hash = await withdrawOnChain(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address, certificate);
        page.notice = `Withdrawal released on ${ns.chain_name} (tx ${shortHex(hash, 8, 6)}) to ${shortHex(recipient, 6, 4)}.`;
      });
    } else if (form.id === 'pl-mint-form') {
      const ns = l.namespace!;
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0') return invalid('enter an amount');
      page.tab = 'overview';
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
        page.notice = 'Test funds credited under incoming. They become available once claimed.';
      });
    }
  });

  const unsubAuth = onAuthChange(() => {
    void refreshWalletBalance().then(() => paint());
  });
  const unsubLinks = onLinksChange(() => {
    void refresh().then(() => paint());
  });

  paint();
  void (async () => {
    await loadStatus();
    await resumeSignIn();
    await resumeInjected();
    await refresh();
    await refreshWalletBalance();
    paint();
    // A returning visit with a signed-in session and an account on this
    // device unlocks by itself: no prompt of any kind.
    const l = links();
    const evm = session();
    if (!l.account && l.hasStoredAccount && l.signedIn && evm.address && l.signedIn.toLowerCase() === evm.address.toLowerCase()) void doActivate();
    syncTimer = window.setInterval(() => void syncOnce(), 5000);
  })();

  return () => {
    stale = true;
    window.clearInterval(syncTimer);
    unsubAuth();
    unsubLinks();
    document.body.classList.remove('pla-page');
    document.title = previousTitle;
  };
}

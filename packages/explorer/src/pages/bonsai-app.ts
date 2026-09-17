// Peal Private Links: the app (#/bonsai/app and its sections).
//
// One wallet, private by default: the connected EVM wallet is the only
// identity on this page. The private account behind it is provisioned,
// unlocked or recovered by the session module; nothing here shows a
// Bonsai account id, a key, a nullifier or a proof. Everything is read
// from the node and from the wallet inside the proving worker; nothing is
// fixture data. Money is base units as decimal strings until the moment it
// is formatted for a human.
//
// Shape: a product shell. A sidebar with the sections and the wallet, a
// top bar with the breadcrumb, the network and the wallet chip, a main
// column with a page head and cards. Sections and pages live in the URL
// fragment (#/bonsai/app/links), so the browser's back button works and
// every page has a way back. Rows open a details drawer on the right.
// Money actions are pages with a form, and the page never repaints under
// a form the person has started filling in.
import QRCode from 'qrcode';
import type { LinksAccount, NamespaceInfo, PaymentRequest, WalletView } from 'peal-links';
import { claimTestFunds, depositOnChain, ensureGas, LinksApiError, testFundsSource, tokenBalance, withdrawOnChain } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, injectedProvider, onAuthChange, resumeInjected, session } from '../auth';
import { connectorLine } from '../links/connectors';
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

export const BRAND = 'Peal Private Links';

// ---- page-local state ---------------------------------------------------

/** The sections in the sidebar, and the pages that open from them. */
type Tab = 'overview' | 'links' | 'incoming' | 'activity' | 'settings' | 'new-link' | 'link-created' | 'send' | 'fund' | 'withdraw' | 'mint' | 'rename' | 'restore';

/** Pages that are one form: they sit centred in a narrower measure. */
const FORM_TABS: Tab[] = ['new-link', 'link-created', 'send', 'fund', 'withdraw', 'mint', 'rename', 'restore'];

const TABS: Tab[] = ['overview', 'links', 'incoming', 'activity', 'settings', 'new-link', 'link-created', 'send', 'fund', 'withdraw', 'mint', 'rename', 'restore'];

const SECTIONS: Array<{ tab: Tab; label: string; icon: string }> = [
  { tab: 'overview', label: 'Overview', icon: 'home' },
  { tab: 'links', label: 'Payment links', icon: 'link' },
  { tab: 'incoming', label: 'Incoming', icon: 'inbox' },
  { tab: 'activity', label: 'Activity', icon: 'activity' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

/** Which section a page belongs to (sidebar highlight, breadcrumb, back). */
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

const TITLES: Record<Tab, string> = {
  overview: 'Overview',
  links: 'Payment links',
  incoming: 'Incoming',
  activity: 'Activity',
  settings: 'Settings',
  'new-link': 'New payment link',
  'link-created': 'Your payment link',
  send: 'Send to an address',
  fund: 'Add funds',
  withdraw: 'Withdraw',
  mint: 'Add test funds',
  rename: 'Display name',
  restore: 'Import a backup file',
};

type Drawer = { kind: 'link'; id: string } | { kind: 'receipt'; idx: number } | { kind: 'history'; i: number } | null;

interface PageState {
  tab: Tab;
  drawer: Drawer;
  menu: boolean;
  q: string;
  filter: string;
  prefill: { title: string; amount: string; reference: string } | null;
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
  drawer: null,
  menu: false,
  q: '',
  filter: 'all',
  prefill: null,
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

function hashFor(tab: Tab): string {
  return tab === 'overview' ? '#/bonsai/app' : `#/bonsai/app/${tab}`;
}

function tabFromHash(): Tab {
  const m = /^#\/bonsai\/app(?:\/([a-z-]+))?/.exec(location.hash);
  const t = m?.[1] as Tab | undefined;
  return t && TABS.includes(t) ? t : 'overview';
}

// ---- small pieces -----------------------------------------------------------

const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-7A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  wallet: '<path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/><path d="M18 13h-2a1 1 0 0 0 0 2h2a1 1 0 0 0 0-2z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
};

function icon(name: string): string {
  return `<svg class="pla-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

function statusChip(status: string): string {
  const tone = status === 'fulfilled' ? 'pl-status-ok' : status === 'active' ? 'pl-status-pending' : 'pl-status-bad';
  const label = status === 'fulfilled' ? 'paid' : status === 'active' ? 'awaiting payment' : status;
  return `<span class="pl-status ${tone}"><span class="pl-status-dot"></span>${esc(label)}</span>`;
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
      <strong>Services are not running.</strong> ${esc(err)}. Start the stack and reload:
      <pre class="pl-code">NETWORK=sepolia scripts/peal-links/testnet.sh up</pre>
    </div>`;
}

/** "Today", "Yesterday", or the weekday and date. */
function dayLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function groupByDay<T>(items: T[], at: (t: T) => number): Array<{ label: string; items: T[] }> {
  const out: Array<{ label: string; items: T[] }> = [];
  for (const it of items) {
    const label = dayLabel(at(it));
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

function money(units: string, ns: NamespaceInfo, sign = ''): string {
  return `${sign}${formatUnits(units, ns.decimals)} <span class="pla-unit">${esc(ns.token_symbol)}</span>`;
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

/** Radio cards, for a choice between a few options. */
function choices(name: string, options: Array<{ value: string; title: string; hint: string; checked?: boolean }>): string {
  return `<div class="pla-choices" role="radiogroup">${options
    .map(
      (o) =>
        `<label class="pla-choice"><input type="radio" name="${name}" value="${esc(o.value)}" ${o.checked ? 'checked' : ''}><span class="pla-choice-dot"></span><span class="pla-choice-text"><b>${esc(o.title)}</b><i>${esc(o.hint)}</i></span></label>`,
    )
    .join('')}</div>`;
}

/** A deterministic identicon for an address: three soft colour fields on a
 * disc, hue and placement from the address bytes, so the same wallet always
 * gets the same mark and no two look alike at a glance. */
function avatar(address: string, size = 28): string {
  const hex = address.replace(/^0x/, '').toLowerCase().padEnd(40, '0');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const h1 = (n(0) * 360) / 255;
  const h2 = (h1 + 140 + (n(2) % 80)) % 360;
  const h3 = (h1 + 220 + (n(4) % 80)) % 360;
  const cx = 8 + (n(6) % 16);
  const cy = 8 + (n(8) % 16);
  const dx = 16 + (n(10) % 12);
  const dy = 20 + (n(12) % 8);
  const id = `av${hex.slice(0, 8)}`;
  return `<svg class="pla-avatar" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <defs><clipPath id="${id}"><circle cx="16" cy="16" r="16"/></clipPath></defs>
    <g clip-path="url(#${id})">
      <rect width="32" height="32" fill="hsl(${h1.toFixed(0)} 70% 62%)"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="hsl(${h2.toFixed(0)} 75% 60%)" opacity="0.9"/>
      <circle cx="${dx}" cy="${dy}" r="12" fill="hsl(${h3.toFixed(0)} 80% 66%)" opacity="0.85"/>
    </g>
  </svg>`;
}

/** First letter up, for messages the session module writes in lowercase. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Something is running: a spinner, the step, and a moving bar. */
function busyBanner(text: string): string {
  return `<div class="pla-busy" role="status" aria-live="polite"><span class="pla-spinner" aria-hidden="true"></span><span class="pla-busy-text">${esc(cap(text))}</span><span class="pla-busy-bar" aria-hidden="true"></span></div>`;
}

function kv(rows: Array<[string, string]>): string {
  return `<dl class="pla-kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

// ---- the shell --------------------------------------------------------------

function sidebar(): string {
  const l = links();
  const evm = session();
  const active = PARENT[page.tab];
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
      <a class="pla-brand" href="#/bonsai"><img class="pla-brand-logo" src="/peal-logo.png" alt="" width="32" height="32"><span>${BRAND}</span></a>
      <nav class="pla-nav" aria-label="sections">
        ${SECTIONS.map((s) => `<a class="pla-nav-item${active === s.tab ? ' is-active' : ''}" href="${hashFor(s.tab)}" ${active === s.tab ? 'aria-current="page"' : ''}>${icon(s.icon)}<span>${s.label}</span></a>`).join('')}
      </nav>
      ${wallet}
      <a class="pla-home" href="#/">${icon('back')} Peal Network</a>
    </aside>`;
}

function topbar(): string {
  const l = links();
  const evm = session();
  const parent = PARENT[page.tab];
  const crumbs = [`<a class="pla-crumb" href="${hashFor('overview')}">${BRAND}</a>`];
  if (parent !== 'overview' || page.tab !== 'overview') crumbs.push(`<a class="pla-crumb" href="${hashFor(parent)}">${TITLES[parent]}</a>`);
  if (page.tab !== parent) crumbs.push(`<span class="pla-crumb is-here">${TITLES[page.tab]}</span>`);
  const nsSelect =
    l.status && l.status.namespaces.length > 1
      ? `<label class="pla-chip pla-chip-select"><span class="pla-chip-dot ${l.namespace?.available ? 'is-live' : ''}"></span><select class="pla-select" id="pl-ns" aria-label="network">${l.status.namespaces.map((n) => `<option value="${esc(n.id)}" ${n.id === l.namespace!.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select></label>`
      : l.namespace
        ? `<span class="pla-chip"><span class="pla-chip-dot ${l.namespace.available ? 'is-live' : ''}"></span>${esc(l.namespace.label)}</span>`
        : '';
  const who = evm.address
    ? `<a class="pla-chip pla-chip-wallet" href="${hashFor('settings')}" title="${evm.source === 'privy' ? 'Privy wallet' : 'browser wallet'}">${avatar(evm.address, 28)}<span class="pla-chip-text"><b>${esc(page.displayName ?? shortHex(evm.address, 6, 4))}</b><i>${evm.source === 'privy' ? 'Privy wallet' : 'browser wallet'} · ${esc(shortHex(evm.address, 6, 4))}</i></span></a>`
    : '';
  return `
    <header class="pla-top">
      <nav class="pla-crumbs" aria-label="breadcrumb">${crumbs.join(`<span class="pla-crumb-sep">${icon('chev')}</span>`)}</nav>
      <div class="pla-top-r">
        ${nsSelect}
        <a class="pla-iconbtn" href="#/bonsai" title="how it works" aria-label="how it works">${icon('help')}</a>
        ${who}
      </div>
    </header>`;
}

function head(title: string, sub: string, actions = '', back: Tab | null = null): string {
  return `
    <div class="pla-head">
      <div class="pla-head-l">
        ${back ? `<button type="button" class="pla-back" data-back="${back}" aria-label="back">${icon('back')}</button>` : ''}
        <div><h1 class="pla-title">${title}</h1><p class="pla-sub">${sub}</p></div>
      </div>
      ${actions ? `<div class="pla-head-r">${actions}</div>` : ''}
    </div>`;
}

function notices(): string {
  const l = links();
  return `
    ${page.error ? `<div class="pl-notice pl-notice-bad" role="alert">${esc(page.error)}</div>` : ''}
    ${page.notice ? `<div class="pl-notice pla-notice-ok" role="status">${esc(page.notice)}</div>` : ''}
    ${page.busy && !(!l.account && ['signing-in', 'checking', 'setting-up', 'recovery-signature'].includes(l.setup)) ? busyBanner(page.busy) : ''}
    ${l.paramsProgress && !page.busy ? busyBanner(l.paramsProgress) : ''}
    ${recoveryCodeBanner()}
    ${invitePanel()}`;
}

function recoveryCodeBanner(): string {
  const code = links().newRecoveryCode;
  if (!code) return '';
  return `
    <div class="pl-notice pl-notice-warn" role="alert">
      <strong>Save your recovery code now.</strong> Your wallet cannot derive a recovery key, so this code protects the backup of your private account. It is shown once and Peal never stores it; without it, a new browser cannot recover your balance.
      <div class="pl-share-link" style="margin-top:10px"><input class="pla-input pl-mono" readonly value="${esc(code)}" id="pl-code"><button type="button" class="pla-btn" data-copy="${esc(code)}">Copy</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pla-btn pla-btn-dark" id="pl-code-saved">I saved it</button></div>
    </div>`;
}

function invitePanel(): string {
  if (!page.invite) return '';
  const url = inviteUrl(page.invite);
  return `
    <div class="pl-notice pl-notice-warn" role="status" id="pl-invite">
      <strong>${esc(shortHex(page.invite, 6, 4))} has not activated private receiving on ${BRAND} yet.</strong> No funds were moved. Send them this invitation; once they connect their wallet and continue, you can pay them privately.
      <div class="pl-share-link" style="margin-top:10px"><input class="pla-input" readonly value="${esc(url)}" id="pl-invite-url"><button type="button" class="pla-btn" data-copy="${esc(url)}">Copy invitation</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pla-btn" id="pl-invite-close">Close</button></div>
    </div>`;
}

// ---- onboarding: connect, continue, recover ---------------------------------

function onboarding(): string {
  const l = links();
  const evm = session();
  if (!evm.address) {
    const injected = injectedProvider() !== null;
    return `
      ${notices()}
      <div class="pla-welcome">
        <img class="pla-welcome-logo" src="/peal-logo.png" alt="" width="64" height="64">
        <h1 class="pla-welcome-title">Welcome to ${BRAND}</h1>
        <p class="pla-welcome-sub">Your wallet is your payment identity. Peal keeps a private account behind it: payments between Peal users hide the amount and the parties, and there is nothing to install or remember.</p>
        <button type="button" class="pla-btn pla-btn-dark pla-btn-lg" id="pl-login-injected" aria-label="Use browser wallet" ${injected ? '' : 'disabled'}>${icon('wallet')} Connect wallet</button>
        <p class="pla-welcome-note">${injected ? 'MetaMask, Rabby or another browser wallet. Deposits and withdrawals are public on the chain, like any token transfer.' : `No browser wallet found. <a class="pla-link" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get MetaMask</a>, then reload this page.`}</p>
      </div>`;
  }
  if (page.tab === 'restore') return restorePage();
  let body: string;
  switch (l.setup) {
    case 'signing-in':
    case 'checking':
    case 'setting-up':
    case 'recovery-signature': {
      const steps: Array<[string, string]> = l.hasStoredAccount
        ? [
            ['Sign in', 'One signature so the node knows it is your wallet'],
            ['Open your account', 'Unlocked on this device, no signature needed'],
          ]
        : [
            ['Sign in', 'One signature so the node knows it is your wallet'],
            ['Authorize a private account', 'Your wallet signs the Peal Private Links authorization'],
            ['Set up recovery', 'A recovery message, or a code shown once'],
          ];
      const at = l.setup === 'signing-in' ? 0 : l.setup === 'checking' ? (l.hasStoredAccount ? 1 : 0) : l.setup === 'setting-up' ? 1 : 2;
      const current = Math.min(at, steps.length - 1);
      body = `
        <ol class="pla-progress" aria-label="setting up">
          ${steps
            .map(([t, d], i) => {
              const state = i < current ? 'done' : i === current ? 'now' : 'todo';
              return `<li class="is-${state}"><span class="pla-progress-dot">${state === 'done' ? icon('check') : state === 'now' ? '<span class="pla-spinner pla-spinner-sm"></span>' : ''}</span><b>${t}</b><i>${state === 'now' && l.setupDetail ? esc(cap(l.setupDetail)) : d}</i></li>`;
            })
            .join('')}
        </ol>
        <p class="pla-welcome-note">Check your wallet for the request. Nothing is sent to the chain during setup.</p>`;
      break;
    }
    case 'needs-recovery-code':
      body = `
        <p class="pla-welcome-sub">This wallet already has private payments on ${BRAND}. Its backup is protected by the recovery code you saved when you set it up.</p>
        <form id="pl-recovery-code" class="pla-form pla-welcome-form">
          ${field('Recovery code', input('name="code" required autocomplete="off" placeholder="PEAL-XXXXX-XXXXX-XXXXX-XXXXX"'))}
          <div class="pla-form-actions"><button type="submit" class="pla-btn pla-btn-dark pla-btn-lg pla-btn-block">Open my account</button><a class="pla-link" href="${hashFor('restore')}">Import a backup file instead</a></div>
        </form>`;
      break;
    case 'no-backup':
      body = `
        <div class="pl-notice pl-notice-warn">${esc(l.setupDetail ?? 'no backup is stored for this wallet')}</div>
        <div class="pla-form-actions"><a class="pla-btn pla-btn-block" href="${hashFor('restore')}">Import a backup file</a></div>`;
      break;
    default:
      body = `
        <p class="pla-welcome-sub">${l.hasStoredAccount ? 'Your private account is on this device. Continue to unlock it; no signature is needed.' : `First time here: your wallet will confirm one ${BRAND} message that authorizes a private account for it, and one recovery message so the account can be recovered from any device.`}</p>
        ${l.setupDetail ? `<div class="pl-notice pl-notice-warn">${esc(l.setupDetail)}</div>` : ''}
        <button type="button" class="pla-btn pla-btn-dark pla-btn-lg" id="pl-activate">Continue with this wallet</button>
        <p class="pla-welcome-note"><a class="pla-link" href="${hashFor('restore')}">Import a backup file</a> · <button type="button" class="pla-link" id="pl-disconnect">Use a different wallet</button></p>`;
  }
  return `
    ${notices()}
    <div class="pla-welcome">
      <span class="pla-welcome-avatar">${avatar(evm.address, 64)}</span>
      <h1 class="pla-welcome-title">${esc(shortHex(evm.address, 6, 4))}</h1>
      <p class="pla-welcome-kicker">${connectorLine()}</p>
      ${body}
    </div>`;
}

// ---- overview -------------------------------------------------------------

/** On a test namespace, where to get the asset: a button the app can act
 * on, or a link to an external faucet. */
function testFundsItem(ns: NamespaceInfo): string {
  const src = testFundsSource(ns);
  if (!src || !session().address) return '';
  if (src.kind === 'external') return `<a class="pla-menu-item" href="${esc(src.url)}" target="_blank" rel="noreferrer">${icon('ext')} Get testnet ${esc(ns.token_symbol)}</a>`;
  return `<button type="button" class="pla-menu-item" id="pl-test-funds">${icon('down')} Get test ${esc(ns.token_symbol)}</button>`;
}

function balanceBlock(): string {
  const l = links();
  const ns = l.namespace!;
  const v = page.view;
  const demo = ns.environment !== 'mainnet';
  const devMint = !!l.status?.dev_mint;
  const nsAvail = !!ns.available;
  const hasWallet = !!session().address;
  const canSettle = nsAvail && l.status?.signer_mode !== 'none';
  const wallet = page.walletTokenBalance !== null ? formatUnits(page.walletTokenBalance, ns.decimals) : null;
  const fund = nsAvail
    ? `<button type="button" class="pla-pill" data-tab="fund" ${hasWallet ? '' : 'disabled'}>${icon('down')} Add funds</button>`
    : devMint
      ? `<button type="button" class="pla-pill" data-tab="mint">${icon('down')} Add test funds</button>`
      : `<button type="button" class="pla-pill" disabled title="deposits are not available on this network">${icon('down')} Add funds</button>`;
  const withdraw = canSettle
    ? `<button type="button" class="pla-pill" data-tab="withdraw" ${hasWallet ? '' : 'disabled'}>${icon('up')} Withdraw</button>`
    : `<button type="button" class="pla-pill" disabled title="withdrawals are not available on this network">${icon('up')} Withdraw</button>`;
  return `
    <section class="pla-hero">
      <div class="pla-hero-l pl-balance">
        <span class="pla-hero-label">Private balance · ${esc(ns.token_symbol)} on ${esc(ns.chain_name)}${demo ? ` <span class="pla-badge">${esc(ns.environment)} funds</span>` : ''}</span>
        <span class="pla-hero-amount pl-balance-amount">${formatUnits(v?.balance ?? '0', ns.decimals)}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></span>
        <span class="pla-hero-sub">as of now · only you can see it${v?.pending ? ` · <span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(v.pending)} pending</span>` : ''}</span>
      </div>
      <div class="pla-hero-r">
        <div class="pla-pills">
          <button type="button" class="pla-pill pla-pill-dark" data-tab="send">${icon('send')} Send to an address</button>
          <button type="button" class="pla-pill pla-pill-dark" data-tab="new-link">${icon('plus')} New payment link</button>
          ${fund}
          ${withdraw}
          <span class="pla-more">
            <button type="button" class="pla-pill pla-pill-round" id="pl-more" aria-haspopup="menu" aria-expanded="${page.menu}" aria-label="more">${icon('more')}</button>
            ${
              page.menu
                ? `<div class="pla-menu" role="menu">
                    ${testFundsItem(ns)}
                    <button type="button" class="pla-menu-item" id="pl-export-csv">${icon('file')} Export history (CSV)</button>
                    <button type="button" class="pla-menu-item" id="pl-backup">${icon('lock')} Export backup file</button>
                    <a class="pla-menu-item" href="${hashFor('rename')}">${icon('settings')} Change display name</a>
                    <button type="button" class="pla-menu-item" id="pl-refresh">${icon('refresh')} Refresh</button>
                  </div>`
                : ''
            }
          </span>
        </div>
        <div class="pla-hero-stats">
          <a class="pla-ministat pl-balance" href="${hashFor('incoming')}"><span>incoming</span><b class="pl-balance-amount">${money(v?.unclaimed ?? '0', ns)}</b><i>verified, not yet claimed</i></a>
          <span class="pla-ministat pl-balance"><span>wallet</span><b class="pl-balance-amount">${wallet !== null ? `${wallet} <span class="pla-unit">${esc(ns.token_symbol)}</span>` : '—'}</b><i>public on ${esc(ns.chain_name)}</i></span>
        </div>
      </div>
    </section>`;
}

function overview(): string {
  const v = page.view!;
  const recentAct = v.history.slice(-6).reverse();
  const recentLinks = page.requests.slice(0, 5);
  const ns = links().namespace!;
  return `
    ${head('Overview', `${esc(page.displayName ?? shortHex(session().address ?? '', 6, 4))} · your private balance and what happened lately.`)}
    ${notices()}
    ${balanceBlock()}
    <div class="pla-two">
      <div class="pla-card">
        <div class="pla-card-head"><h2 class="pla-card-title">Recent activity</h2><a class="pla-link" href="${hashFor('activity')}">View all</a></div>
        ${recentAct.length ? `<ul class="pla-list">${recentAct.map((h) => historyRow(h, v.history.indexOf(h))).join('')}</ul>` : emptyState('activity', 'No activity yet', 'Deposits, payments sent and received, and withdrawals appear here.')}
      </div>
      <div class="pla-card">
        <div class="pla-card-head"><h2 class="pla-card-title">Payment links</h2><a class="pla-link" href="${hashFor('links')}">View all</a></div>
        ${recentLinks.length ? `<ul class="pla-list">${recentLinks.map(linkRow).join('')}</ul>` : emptyState('link', 'No payment links yet', `A link is a fixed amount in ${esc(ns.token_symbol)} that anyone can pay you privately, once.`)}
      </div>
    </div>
    ${ledgerLine()}`;
}

function emptyState(ic: string, title: string, text: string, action = ''): string {
  return `<div class="pla-empty"><span class="pla-empty-ic">${icon(ic)}</span><b>${title}</b><span>${text}</span>${action}</div>`;
}

function ledgerLine(): string {
  const s = links().status!;
  const ns = links().namespace!;
  const led = s.ledgers.find((l) => l.namespace === ns.id);
  return `<p class="pla-foot">${s.setup === 'local-dev' ? `<strong>Local development setup.</strong> proving keys generated locally (no ceremony), balances in ${esc(ns.environment)} funds · ` : ''}ledger ${esc(s.ledger_mode)}${s.consensus ? ` · height ${s.consensus.height}` : ''}${led ? ` · ${led.receipt_count} receipts` : ''} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></p>`;
}

// ---- rows ---------------------------------------------------------------------

function linkRow(r: PaymentRequest): string {
  const ns = links().namespace!;
  const m = r.manifest;
  return `<li><button type="button" class="pla-row" data-open-link="${esc(m.request_id)}">
    <span class="pla-row-ic">${icon('link')}</span>
    <span class="pla-row-main"><b>${esc(m.title)}</b><i>${statusChip(r.status)}${m.reference ? ` · ${esc(m.reference)}` : ''} · ${esc(fmtTime(m.created_at))}</i></span>
    <span class="pla-row-side"><b>${money(m.amount, ns)}</b></span>
    <span class="pla-row-chev">${icon('chev')}</span>
  </button></li>`;
}

function receiptRow(r: WalletView['receipts'][number], idx: number): string {
  const ns = links().namespace!;
  const what = r.sender === MINT_SENDER ? 'deposit from your wallet' : 'private payment';
  const req = r.reference && /^[a-z2-7]{24}$/.test(r.reference) ? page.requests.find((q) => q.manifest.request_id === r.reference) : null;
  const ref = req ? `for “${esc(req.manifest.title)}”` : r.reference && /^[a-z2-7]{24}$/.test(r.reference) ? `for link ${esc(r.reference.slice(0, 8))}…` : r.reference ? esc(r.reference) : '';
  return `<li><button type="button" class="pla-row" data-open-receipt="${idx}">
    <span class="pla-row-ic pla-row-ic-in">${icon('down')}</span>
    <span class="pla-row-main"><b>${what}</b><i>${receiptStatus(r.status)}${ref ? ` · ${ref}` : ''} · ${esc(fmtTime(r.discovered_at))}</i></span>
    <span class="pla-row-side"><b class="pla-pos">${money(r.amount, ns, '+')}</b></span>
    <span class="pla-row-chev">${icon('chev')}</span>
  </button></li>`;
}

function historyLabel(h: WalletView['history'][number]): string {
  const to = h.position !== null ? page.labels[String(h.position)] : undefined;
  return h.kind === 'send'
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
}

function historyRow(h: WalletView['history'][number], i: number): string {
  const ns = links().namespace!;
  const out = h.kind === 'send';
  return `<li><button type="button" class="pla-row" data-open-history="${i}">
    <span class="pla-row-ic ${out ? 'pla-row-ic-out' : 'pla-row-ic-in'}">${icon(out ? 'up' : 'down')}</span>
    <span class="pla-row-main"><b>${historyLabel(h)}</b><i>${out ? 'Sent' : 'Received'} · ${esc(fmtTime(h.at))}</i></span>
    <span class="pla-row-side"><b class="${out ? 'pla-neg' : 'pla-pos'}">${money(h.amount, ns, out ? '−' : '+')}</b></span>
    <span class="pla-row-chev">${icon('chev')}</span>
  </button></li>`;
}

function grouped<T>(items: T[], at: (t: T) => number, row: (t: T) => string): string {
  return groupByDay(items, at)
    .map((g) => `<div class="pla-group"><h3 class="pla-group-label">${esc(g.label)}</h3><ul class="pla-list">${g.items.map(row).join('')}</ul></div>`)
    .join('');
}

// ---- sections -------------------------------------------------------------

function linksPage(): string {
  const ns = links().namespace!;
  const q = page.q.trim().toLowerCase();
  const filters: Array<[string, string]> = [
    ['all', 'All'],
    ['active', 'Awaiting'],
    ['fulfilled', 'Paid'],
    ['expired', 'Expired'],
    ['archived', 'Archived'],
  ];
  const list = page.requests.filter((r) => (page.filter === 'all' || r.status === page.filter) && (!q || r.manifest.title.toLowerCase().includes(q) || (r.manifest.reference ?? '').toLowerCase().includes(q)));
  const paid = page.requests.filter((r) => r.status === 'fulfilled');
  const total = paid.reduce((a, r) => a + BigInt(r.manifest.amount), 0n).toString();
  return `
    ${head('Payment links', `A link is a fixed amount in ${esc(ns.token_symbol)} that anyone can pay you privately, once.`, `<button type="button" class="pla-btn pla-btn-dark" data-tab="new-link">${icon('plus')} New payment link</button>`)}
    ${notices()}
    <div class="pla-stats">
      <div class="pla-stat"><span class="pla-stat-label">links</span><b class="pla-stat-n">${page.requests.length}</b><i>${page.requests.filter((r) => r.status === 'active').length} awaiting payment</i></div>
      <div class="pla-stat"><span class="pla-stat-label">paid</span><b class="pla-stat-n">${paid.length}</b><i>${money(total, ns)} received through links</i></div>
      <div class="pla-stat"><span class="pla-stat-label">how it is paid</span><b class="pla-stat-n pla-stat-text">privately</b><i>the amount and the parties stay inside the proof</i></div>
    </div>
    <div class="pla-toolbar">
      <label class="pla-search">${icon('search')}<input type="search" name="q" id="pla-search" placeholder="Search by title or reference" value="${esc(page.q)}" autocomplete="off"></label>
      <div class="pla-filters" role="group" aria-label="filter">${filters.map(([v, t]) => `<button type="button" class="pla-filter${page.filter === v ? ' is-on' : ''}" data-filter="${v}">${t}</button>`).join('')}</div>
    </div>
    <div class="pla-card">
      ${list.length ? grouped(list, (r) => r.manifest.created_at, linkRow) : emptyState('link', page.requests.length ? 'Nothing matches' : 'No payment links yet', page.requests.length ? 'Try another word or filter.' : 'Create one, share it, and the payment arrives in your private balance.', page.requests.length ? '' : `<button type="button" class="pla-btn pla-btn-dark" data-tab="new-link">${icon('plus')} New payment link</button>`)}
    </div>`;
}

function incomingPage(): string {
  const v = page.view!;
  const l = links();
  const ns = l.namespace!;
  const items = v.receipts.map((r, idx) => ({ r, idx })).reverse();
  const waiting = v.receipts.filter((r) => r.status === 'unclaimed');
  return `
    ${head('Incoming', 'Payments addressed to you. Claiming adds them to your private balance.', `<label class="pla-switch"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}><span class="pla-switch-track"></span><span>claim automatically</span></label>`)}
    ${notices()}
    <div class="pla-stats">
      <div class="pla-stat pla-stat-primary"><span class="pla-stat-label">ready to claim</span><b class="pla-stat-n">${money(v.unclaimed, ns)}</b><i>${waiting.length} payment${waiting.length === 1 ? '' : 's'} verified against the ledger</i></div>
      <div class="pla-stat"><span class="pla-stat-label">received in total</span><b class="pla-stat-n">${money(v.receipts.reduce((a, r) => a + BigInt(r.amount), 0n).toString(), ns)}</b><i>${v.receipts.length} payment${v.receipts.length === 1 ? '' : 's'}</i></div>
    </div>
    <div class="pla-card">
      ${items.length ? grouped(items, (x) => x.r.discovered_at, (x) => receiptRow(x.r, x.idx)) : emptyState('inbox', 'Nothing incoming', 'Payments appear here as soon as they reach you, even if you were offline when they were made.')}
    </div>`;
}

function activityPage(): string {
  const ns = links().namespace!;
  const v = page.view!;
  const items = v.history.map((h, i) => ({ h, i })).reverse();
  const sent = v.history.filter((h) => h.kind === 'send').reduce((a, h) => a + BigInt(h.amount), 0n).toString();
  const got = v.history.filter((h) => h.kind !== 'send').reduce((a, h) => a + BigInt(h.amount), 0n).toString();
  return `
    ${head('Activity', 'Everything this account did, decrypted on this device. The chain never gets this list.', `<button type="button" class="pla-btn" id="pl-export-csv" title="a plaintext file of this account's receipts and payments">${icon('file')} Export CSV</button>`)}
    ${notices()}
    <div class="pla-stats">
      <div class="pla-stat"><span class="pla-stat-label">received</span><b class="pla-stat-n pla-pos">${money(got, ns, '+')}</b><i>claimed into your balance</i></div>
      <div class="pla-stat"><span class="pla-stat-label">sent</span><b class="pla-stat-n">${money(sent, ns, '−')}</b><i>payments and withdrawals</i></div>
      <div class="pla-stat"><span class="pla-stat-label">withdrawals</span><b class="pla-stat-n">${page.withdrawals.length}</b><i>${page.withdrawals.filter((w) => w.status === 'confirmed').length} confirmed on chain</i></div>
    </div>
    <div class="pla-card">
      ${items.length ? grouped(items, (x) => x.h.at, (x) => historyRow(x.h, x.i)) : emptyState('activity', 'No activity yet', 'Deposits, payments sent and received, and withdrawals appear here.')}
    </div>`;
}

function settingsPage(): string {
  const l = links();
  const s = l.status!;
  const evm = session();
  return `
    ${head('Settings', 'Your name on links, recovery, backups and this device.')}
    ${notices()}
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">Profile</h2></div>
      <div class="pla-setting"><div><b>Display name</b><i>${esc(page.displayName ?? shortHex(evm.address ?? '', 6, 4))} · shown next to your wallet address on your links; a name you chose, not an identity check</i></div><a class="pla-btn" href="${hashFor('rename')}">Change display name</a></div>
      <div class="pla-setting"><div><b>Wallet</b><i>${connectorLine()} · the only identity anyone sees</i></div></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">Recovery and backups</h2></div>
      <div class="pla-setting"><div><b>Recovery</b><i>${page.recovery === 'wallet-signature' ? 'your wallet signature opens your backup on any device' : 'your recovery code opens your backup on any device'}; the backup is kept encrypted by the node and Peal cannot open it</i></div></div>
      <div class="pla-setting"><div><b>Backup file</b><i>an encrypted copy of your private account, for a device that cannot reach the node's backup</i></div><div class="pla-setting-actions"><button type="button" class="pla-btn" id="pl-backup">Export backup file</button><a class="pla-btn" href="${hashFor('restore')}">Import a backup file</a></div></div>
      <div class="pla-setting"><div><b>History export</b><i>a plaintext CSV of your payments; anyone with the file learns exactly that</i></div><button type="button" class="pla-btn" id="pl-export-csv">Export CSV</button></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">This device</h2></div>
      <div class="pla-setting"><div><b>Claim incoming automatically</b><i>while this page is open, incoming payments are proved and claimed by themselves</i></div><label class="pla-switch"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}><span class="pla-switch-track"></span></label></div>
      <div class="pla-setting"><div><b>Lock</b><i>closes the private account on this device; reconnecting the same wallet unlocks it with no signature</i></div><button type="button" class="pla-btn" id="pl-lock">Lock</button></div>
      <div class="pla-setting"><div><b>Disconnect</b><i>${evm.source === 'privy' ? 'logs out of Privy and locks the account on this device' : 'forgets this browser wallet and locks the account on this device'}</i></div><button type="button" class="pla-btn" id="pl-disconnect">Disconnect</button></div>
    </div>
    <div class="pla-card">
      <div class="pla-card-head"><h2 class="pla-card-title">Network</h2></div>
      ${s.setup === 'local-dev' ? `<div class="pla-setting"><div><b>Local development setup</b><i>proving keys generated locally (no ceremony), ledger in ${esc(s.ledger_mode)} mode, balances in ${esc(l.namespace!.environment)} funds. This is the demo's trust model, stated plainly.</i></div></div>` : ''}
      ${s.namespaces
        .map((ns) => {
          const led = s.ledgers.find((x) => x.namespace === ns.id);
          return `<div class="pla-setting"><div><b>${esc(ns.label)}</b><i>${esc(ns.token_symbol)} on ${esc(ns.chain_name)} · ${ns.available ? 'available' : 'not available'} · ${esc(ns.environment)} funds${led ? ` · ${led.receipt_count} receipts · state root <span class="pl-mono">${esc(led.state_root.slice(0, 16))}…</span>` : ''}${ns.gateway ? ` · gateway <a class="pla-link" href="${esc(ns.explorer_url)}/address/${esc(ns.gateway)}" target="_blank" rel="noreferrer">${esc(shortHex(ns.gateway, 6, 4))}</a>` : ''}</i></div></div>`;
        })
        .join('')}
      <div class="pla-setting"><div><b>Ledger</b><i>${esc(s.ledger_mode)}${s.consensus ? ` · height ${s.consensus.height} · state <span class="pl-mono">${esc(s.consensus.state_root.slice(0, 12))}…</span>` : ''} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></i></div></div>
    </div>`;
}

// ---- form pages --------------------------------------------------------------

function newLinkPage(): string {
  const ns = links().namespace!;
  const p = page.prefill;
  return `
    ${head('New payment link', 'A fixed amount in one asset. Anyone with the link can pay it, once.', '', 'links')}
    ${notices()}
    <form id="pl-request-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-head"><h2 class="pla-card-title">Request details</h2></div>
      <div class="pla-card-body">
        ${field('What is it for', input(`name="title" maxlength="140" required placeholder="Logo files, final" value="${esc(p?.title ?? '')}"`), 'Shown to the payer on the link.')}
        ${field('Amount', input(`name="amount" inputmode="decimal" required placeholder="0.00" value="${esc(p?.amount ?? '')}"`, esc(ns.token_symbol)), `${esc(ns.token_symbol)} on ${esc(ns.chain_name)}. The exact amount; the link can be paid once.`)}
        ${field('Reference', input(`name="reference" maxlength="64" placeholder="INV-0417" value="${esc(p?.reference ?? '')}"`), 'Optional. An invoice number or a note, shown on the link.')}
      </div>
      <div class="pla-card-head"><h2 class="pla-card-title">Expiry</h2></div>
      <div class="pla-card-body">
        ${choices('expiry', [
          { value: '', title: 'No expiry', hint: 'stays payable until you archive it', checked: true },
          { value: '86400', title: '24 hours', hint: 'expires this time tomorrow' },
          { value: '604800', title: '7 days', hint: 'a week from now' },
          { value: '2592000', title: '30 days', hint: 'a month from now' },
        ])}
        <p class="pla-note">The title, amount, your display name and your wallet address are visible to anyone holding the link. Keep sensitive details out of them.</p>
      </div>
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('links')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Create link</button></div>
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
        <div class="pl-share-link" style="margin-top:14px"><input class="pla-input" readonly value="${esc(l.url)}" id="pl-link-url"><button type="button" class="pla-btn" data-copy="${esc(l.url)}">${icon('copy')} Copy</button><a class="pla-btn" href="#/pay/${esc(l.request.manifest.request_id)}" target="_blank" rel="noreferrer">${icon('ext')} Open</a></div>
        <p class="pla-note">Send it any way you like. The payer needs nothing but a wallet; you can close this page and come back later.</p>
        <button type="button" class="pla-btn pla-btn-dark pla-btn-block" data-done>Done</button>
      </div>
    </div>`;
}

function sendPage(): string {
  const ns = links().namespace!;
  return `
    ${head('Send to an address', 'Pay a wallet that uses Peal. The amount and the parties stay private.', '', 'overview')}
    ${notices()}
    <form id="pl-send-form" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Recipient wallet address', input('name="to" required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" spellcheck="false" autocomplete="off"'), `On ${esc(ns.chain_name)}. Their receiving details are looked up and checked against their wallet's signature on this device.`, ' pla-field-mono')}
        ${field('Amount', input('name="amount" inputmode="decimal" required placeholder="0.00"', esc(ns.token_symbol)), page.view ? `Available: ${formatUnits(page.view.balance, ns.decimals)} ${esc(ns.token_symbol)}.` : '')}
        ${field('Note for the recipient', input('name="reference" maxlength="64" placeholder="thanks for lunch"'), 'Optional. Travels inside the encrypted receipt; the chain never sees it.')}
        <div class="pla-steps">
          <div class="pla-step"><b>1</b><span>Their receiving profile is looked up and verified on this device</span></div>
          <div class="pla-step"><b>2</b><span>Your wallet confirms the payment</span></div>
          <div class="pla-step"><b>3</b><span>Your browser proves it; the ledger checks the proof; an encrypted receipt reaches them</span></div>
        </div>
        <p class="pla-note">Nothing leaves your browser but the proof and the encrypted receipt. If the address has not activated private receiving, no funds move and you get an invitation to send them.</p>
      </div>
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('overview')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Continue</button></div>
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
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('overview')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Deposit from wallet</button></div>
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
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('overview')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Withdraw</button></div>
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
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('overview')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Credit test funds</button></div>
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
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor('settings')}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Save</button></div>
    </form>`;
}

function restorePage(): string {
  const back: Tab = links().account ? 'settings' : 'overview';
  return `
    ${head('Import a backup file', 'A file exported from Peal, protected by the recovery code chosen when exporting it.', '', back)}
    ${notices()}
    <form id="pl-restore" class="pla-form pla-card pla-card-narrow">
      <div class="pla-card-body">
        ${field('Backup file', input('type="file" name="file" accept="application/json,.json" required'))}
        ${field('Recovery code', input('name="code" required autocomplete="off"'), 'The code you chose when the file was exported.', ' pla-field-mono')}
        <p class="pla-note">After importing, the account is checked against the ledger; a backup older than your last operation is reported as stale rather than used.</p>
      </div>
      <div class="pla-form-foot"><a class="pla-btn" href="${hashFor(back)}">Cancel</a><button type="submit" class="pla-btn pla-btn-dark">Import</button></div>
    </form>`;
}

// ---- the details drawer ------------------------------------------------------

function timeline(steps: Array<{ title: string; text: string; state: 'done' | 'now' | 'todo' }>): string {
  return `<ol class="pla-timeline">${steps.map((s) => `<li class="is-${s.state}"><span class="pla-tl-dot">${s.state === 'done' ? icon('check') : ''}</span><b>${s.title}</b><i>${s.text}</i></li>`).join('')}</ol>`;
}

function drawerFor(d: Drawer): string {
  if (!d) return '';
  const ns = links().namespace!;
  let title = '';
  let body = '';
  let foot = '';
  if (d.kind === 'link') {
    const r = page.requests.find((x) => x.manifest.request_id === d.id);
    if (!r) return '';
    const m = r.manifest;
    const url = requestUrl(m.request_id);
    title = 'Payment link details';
    const expired = r.status === 'expired' || (m.expires_at !== null && m.expires_at * 1000 < Date.now() && r.status === 'active');
    body = `
      <div class="pla-drawer-amount"><span class="pla-drawer-ic">${icon('link')}</span><div><span>Amount</span><b>${money(m.amount, ns)}</b></div></div>
      <div class="pla-urlbox"><input class="pla-input" readonly value="${esc(url)}" aria-label="payment link"><button type="button" class="pla-link" data-copy="${esc(url)}">${icon('copy')} Copy</button><a class="pla-link" href="#/pay/${esc(m.request_id)}" target="_blank" rel="noreferrer">${icon('ext')} Visit link</a></div>
      <h3 class="pla-drawer-h">${esc(m.title)}</h3>
      ${kv([
        ['Status', statusChip(r.status)],
        ['Created on', esc(fmtTime(m.created_at))],
        ['Expires on', m.expires_at ? esc(fmtTime(m.expires_at)) : 'never'],
        ['Reference', m.reference ? esc(m.reference) : '—'],
        ['Paid on', r.fulfilled_at ? esc(fmtTime(r.fulfilled_at)) : '—'],
        ['Receiving wallet', `<span class="pl-mono">${esc(shortHex(m.receiver_address, 6, 4))}</span>`],
      ])}
      <h3 class="pla-drawer-h">Timeline</h3>
      ${timeline([
        { title: 'Created payment link', text: fmtTime(m.created_at), state: 'done' },
        r.status === 'fulfilled'
          ? { title: 'Awaiting payment', text: 'A payer opened the link and paid it.', state: 'done' }
          : r.status === 'active' && !expired
            ? { title: 'Awaiting payment', text: r.reserved ? 'Someone is completing this payment right now.' : 'Waiting for the payer. They need nothing but a wallet.', state: 'now' }
            : { title: 'Awaiting payment', text: 'The link is no longer payable.', state: 'done' },
        r.status === 'fulfilled'
          ? { title: 'Payment complete', text: `You received ${formatUnits(m.amount, ns.decimals)} ${ns.token_symbol}, privately.${r.fulfilled_at ? ` ${fmtTime(r.fulfilled_at)}.` : ''}`, state: 'now' }
          : r.status === 'archived'
            ? { title: 'Archived', text: 'Withdrawn by you.', state: 'now' }
            : expired
              ? { title: 'Expired', text: 'The expiry passed before it was paid.', state: 'now' }
              : { title: 'Payment complete', text: 'The amount lands in your private balance.', state: 'todo' },
      ])}`;
    foot = `${r.status === 'active' ? `<button type="button" class="pla-link pla-link-quiet" data-archive="${esc(m.request_id)}">Cancel request</button>` : ''}<button type="button" class="pla-btn pla-btn-dark" data-again="${esc(m.request_id)}">Request this again</button>`;
  } else if (d.kind === 'receipt') {
    const r = page.view?.receipts[d.idx];
    if (!r) return '';
    const req = r.reference && /^[a-z2-7]{24}$/.test(r.reference) ? page.requests.find((q) => q.manifest.request_id === r.reference) : null;
    title = 'Incoming payment';
    body = `
      <div class="pla-drawer-amount"><span class="pla-drawer-ic pla-row-ic-in">${icon('down')}</span><div><span>Amount</span><b class="pla-pos">${money(r.amount, ns, '+')}</b></div></div>
      ${kv([
        ['Status', receiptStatus(r.status)],
        ['Kind', r.sender === MINT_SENDER ? 'deposit from your wallet' : 'private payment'],
        ['Arrived', esc(fmtTime(r.discovered_at))],
        ['For', req ? `${esc(req.manifest.title)}${req.manifest.reference ? ` · ${esc(req.manifest.reference)}` : ''}` : r.reference ? esc(r.reference) : '—'],
        ['Ledger position', String(r.position)],
      ])}
      <h3 class="pla-drawer-h">Timeline</h3>
      ${timeline([
        { title: 'Payment reached you', text: 'An encrypted receipt was left in your inbox.', state: 'done' },
        { title: 'Verified against the ledger', text: 'The receipt commitment is on the ledger.', state: r.status === 'unclaimed' || r.status === 'claimed' || r.status === 'claiming' ? 'done' : r.status === 'invalid' ? 'done' : 'now' },
        r.status === 'claimed'
          ? { title: 'Claimed', text: 'Added to your private balance.', state: 'now' }
          : { title: 'Claim', text: r.status === 'claiming' ? 'Proving on this device.' : 'A proof on this device adds it to your spendable balance.', state: r.status === 'unclaimed' || r.status === 'claiming' ? 'now' : 'todo' },
      ])}`;
    foot = r.status === 'unclaimed' ? `<button type="button" class="pla-btn pla-btn-dark" data-claim="${d.idx}">Claim now</button>` : '';
  } else {
    const h = page.view?.history[d.i];
    if (!h) return '';
    const out = h.kind === 'send';
    const wd = h.reference?.startsWith('withdraw:') ? page.withdrawals.find((w) => w.position === h.position) : null;
    const to = h.position !== null ? page.labels[String(h.position)] : undefined;
    const req = h.reference && /^[a-z2-7]{24}$/.test(h.reference) ? page.requests.find((q) => q.manifest.request_id === h.reference) : null;
    title = out ? 'Payment sent' : 'Payment received';
    body = `
      <div class="pla-drawer-amount"><span class="pla-drawer-ic ${out ? 'pla-row-ic-out' : 'pla-row-ic-in'}">${icon(out ? 'up' : 'down')}</span><div><span>Amount</span><b class="${out ? '' : 'pla-pos'}">${money(h.amount, ns, out ? '−' : '+')}</b></div></div>
      ${kv([
        ['What', esc(historyLabel(h))],
        ['When', esc(fmtTime(h.at))],
        ...(to ? [['To', `<span class="pl-mono">${esc(to)}</span>`] as [string, string]] : []),
        ...(req ? [['Link', esc(req.manifest.title)] as [string, string]] : []),
        ...(h.reference && !req && !wd ? [['Note', esc(h.reference)] as [string, string]] : []),
        ['Ledger position', h.position !== null ? String(h.position) : '—'],
        ...(wd
          ? ([
              ['Recipient', `<span class="pl-mono">${esc(wd.recipient)}</span>`],
              ['Settlement', wd.status === 'confirmed' ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>confirmed on chain</span>` : `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(wd.status.replace('_', ' '))}</span>`],
              ['Transaction', wd.tx_hash ? `<a class="pla-link" href="${esc(ns.explorer_url)}/tx/${esc(wd.tx_hash)}" target="_blank" rel="noreferrer"><span class="pl-mono">${esc(shortHex(wd.tx_hash, 8, 6))}</span> ${icon('ext')}</a>` : '—'],
            ] as Array<[string, string]>)
          : []),
      ])}
      <p class="pla-note">${out ? 'The proof was made on this device; the ledger checked it and kept one commitment. The amount and the other party never appeared on the chain.' : 'The sender proved the payment on their device; you claimed the receipt here. Nobody else can read this entry.'}</p>`;
    foot = '';
  }
  return `
    <div class="pla-scrim" data-drawer-close></div>
    <aside class="pla-drawer" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="pla-drawer-head"><h2>${title}</h2><button type="button" class="pla-iconbtn" data-drawer-close aria-label="close">${icon('close')}</button></div>
      <div class="pla-drawer-body">${body}</div>
      ${foot ? `<div class="pla-drawer-foot">${foot}</div>` : ''}
    </aside>`;
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
    return `<div class="pl pla"><div class="pla-shell"><div class="pla-main">${head(BRAND, 'payments')}${l.statusError ? unreachable(l.statusError) : `<div class="skeleton-row"><span class="skeleton" style="width:240px"></span></div>`}</div></div></div>`;
  }
  return `
    <div class="pl pla">
      <div class="pla-shell">
        ${sidebar()}
        <div class="pla-col">
          ${topbar()}
          <div class="pla-main${FORM_TABS.includes(page.tab) ? ' pla-main-narrow' : ''}" data-view="${page.tab}">${main()}</div>
        </div>
        ${drawerFor(page.drawer)}
      </div>
    </div>`;
}

// ---- behaviour ---------------------------------------------------------------

export function renderBonsaiApp(root: HTMLElement): Cleanup {
  const previousTitle = document.title;
  document.title = `${BRAND}. payments`;
  document.body.classList.add('pla-page');
  let stale = false;
  let syncTimer = 0;
  let claiming = false;
  page = initial();
  page.tab = tabFromHash();
  MINT_SENDER = localStorage.getItem(MINT_SENDER_KEY) ?? '';
  // An invitation link (#/bonsai?invite=0x…) lands here: say what it is.
  const invited = /[?&]invite=(0x[0-9a-fA-F]{40})/.exec(location.hash);
  if (invited) page.notice = `Someone wants to pay you privately on ${BRAND}. Connect the wallet ${shortHex(invited[1]!, 6, 4)} and continue; they can pay you once your wallet has private receiving.`;

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
        if (again.type === 'search' || again.type === 'text') again.setSelectionRange(again.value.length, again.value.length);
      }
    }
    window.scrollTo({ top: y });
    if (page.drawer) requestAnimationFrame(() => root.querySelector('.pla-drawer')?.classList.add('is-open'));
  };

  // Where the app has been, so the back control can go back through the
  // browser's history when it was this app that navigated.
  const hist: string[] = [location.hash];
  const go = (tab: Tab) => {
    const h = hashFor(tab);
    if (location.hash === h) return;
    location.hash = h;
  };
  const onHash = () => {
    if (stale) return;
    const tab = tabFromHash();
    if (hist.length > 1 && location.hash === hist[hist.length - 2]) hist.pop();
    else hist.push(location.hash);
    page.tab = tab;
    page.error = null;
    page.drawer = null;
    page.menu = false;
    if (tab !== 'new-link') page.prefill = null;
    paint(true);
    root.querySelector('.pla-main')?.classList.add('pla-enter');
    window.scrollTo({ top: 0 });
  };
  window.addEventListener('hashchange', onHash);

  const back = (parent: Tab) => {
    if (hist.length > 1) history.back();
    else go(parent);
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
        page.requests = (await client.listRequests()).requests.filter((r) => r.manifest.receiver_account === mine).sort((a, b) => b.manifest.created_at - a.manifest.created_at);
      } catch (e) {
        if (e instanceof LinksApiError && e.status === 401) page.requests = [];
      }
    }
  };

  const run = async (label: string, f: () => Promise<void>) => {
    page.busy = label;
    page.error = null;
    page.menu = false;
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

  const exportCsv = () => {
    const l = links();
    const ns = l.namespace!;
    const v = page.view!;
    const ok = confirm('This writes a plaintext CSV of your payments (amounts, direction, positions, times) to a file on this device. Anyone who gets the file learns exactly that. Continue?');
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
  };

  const exportBackup = () => {
    const l = links();
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
  };

  // A form becomes "dirty" on the first keystroke or choice; the paint
  // guard above reads it. The search box is not a form: it repaints the
  // list as you type.
  root.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.id === 'pla-search') {
      page.q = t.value;
      paint(true);
      return;
    }
    t.closest('form')?.setAttribute('data-dirty', '');
  });

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && (page.drawer || page.menu)) {
      page.drawer = null;
      page.menu = false;
      paint(true);
    }
  };
  window.addEventListener('keydown', onKey);

  root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button, a, [data-drawer-close]');
    if (!btn) {
      if (page.menu) {
        page.menu = false;
        paint(true);
      }
      return;
    }
    const l = links();
    if (btn.hasAttribute('data-drawer-close')) {
      page.drawer = null;
      paint(true);
    } else if (btn.dataset.back) back(btn.dataset.back as Tab);
    else if (btn.dataset.tab) go(btn.dataset.tab as Tab);
    else if (btn.hasAttribute('data-done')) {
      page.lastLink = null;
      go('links');
    } else if (btn.dataset.openLink) {
      page.drawer = { kind: 'link', id: btn.dataset.openLink };
      paint(true);
    } else if (btn.dataset.openReceipt !== undefined) {
      page.drawer = { kind: 'receipt', idx: Number(btn.dataset.openReceipt) };
      paint(true);
    } else if (btn.dataset.openHistory !== undefined) {
      page.drawer = { kind: 'history', i: Number(btn.dataset.openHistory) };
      paint(true);
    } else if (btn.dataset.again) {
      const r = page.requests.find((x) => x.manifest.request_id === btn.dataset.again);
      if (r) {
        const ns = l.namespace!;
        page.prefill = { title: r.manifest.title, amount: formatUnits(r.manifest.amount, ns.decimals).replace(/,/g, ''), reference: r.manifest.reference ?? '' };
        page.drawer = null;
        go('new-link');
      }
    } else if (btn.dataset.filter) {
      page.filter = btn.dataset.filter;
      paint(true);
    } else if (btn.id === 'pl-more') {
      page.menu = !page.menu;
      paint(true);
    } else if (btn.id === 'pl-refresh') {
      page.menu = false;
      void run('refreshing', async () => void (await l.account!.sync()));
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
      page.drawer = null;
      paint(true);
      go('overview');
    } else if (btn.id === 'pl-disconnect') {
      disconnect();
      page.view = null;
      page.requests = [];
      page.walletTokenBalance = null;
      page.drawer = null;
      paint(true);
      go('overview');
    } else if (btn.id === 'pl-invite-close') {
      page.invite = null;
      paint(true);
    } else if (btn.id === 'pl-backup') exportBackup();
    else if (btn.id === 'pl-export-csv') {
      page.menu = false;
      exportCsv();
      paint(true);
    } else if (btn.dataset.copy) {
      void navigator.clipboard?.writeText(btn.dataset.copy).then(() => {
        const prev = btn.innerHTML;
        btn.textContent = 'copied';
        window.setTimeout(() => (btn.innerHTML = prev), 1200);
      });
    } else if (btn.dataset.claim !== undefined) {
      const idx = Number(btn.dataset.claim);
      page.drawer = null;
      void run(`claiming: proving on this device (about 7 s)`, async () => {
        const v = await l.account!.view();
        const r = v.receipts[idx]!;
        await l.account!.claim(idx);
        if (r.reference && /^[a-z2-7]{24}$/.test(r.reference)) await l.account!.acknowledge(r.reference, r.position).catch(() => {});
      });
    } else if (btn.dataset.archive) {
      const id = btn.dataset.archive;
      page.drawer = null;
      void run('archiving', async () => void (await client.archiveRequest(id)));
    } else if (btn.closest('.pla-menu')) {
      page.menu = false;
    }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'pl-autoclaim') {
      setAutoClaim((t as HTMLInputElement).checked);
      if ((t as HTMLInputElement).checked) void syncOnce();
    } else if (t.id === 'pl-ns') {
      const ns = links().status?.namespaces.find((n) => n.id === t.value);
      if (ns) void selectNamespace(ns).then(refresh).then(refreshWalletBalance).then(() => paint(true));
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
      go(l.account ? 'settings' : 'overview');
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
      page.prefill = null;
      go('links');
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
        go('link-created');
      });
    } else if (form.id === 'pl-send-form') {
      const ns = l.namespace!;
      const to = String(data.get('to') ?? '').trim();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(to)) return invalid('enter a wallet address and an amount');
      page.invite = null;
      go('overview');
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
      go('settings');
      void run('confirm the new display name in your wallet', async () => {
        await rename(l.account!, name);
      });
    } else if (form.id === 'pl-fund-form') {
      const ns = l.namespace!;
      const evm = session();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !evm.address || !evm.provider) return invalid('enter an amount and connect a wallet');
      go('overview');
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
      go('overview');
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
      go('overview');
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
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('keydown', onKey);
    unsubAuth();
    unsubLinks();
    document.body.classList.remove('pla-page');
    document.title = previousTitle;
  };
}

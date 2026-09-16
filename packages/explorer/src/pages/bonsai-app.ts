// Peal Links: the app (#/bonsai/app).
//
// One wallet, private by default: the connected EVM wallet is the only
// identity on this page. The private account behind it is provisioned,
// unlocked or recovered by the session module; nothing here shows a
// Bonsai account id, a key, a nullifier or a proof. Everything is read
// from the node and from the wallet inside the proving worker; nothing is
// fixture data. Money is base units as decimal strings until the moment it
// is formatted for a human.
import QRCode from 'qrcode';
import type { LinksAccount, NamespaceInfo, PaymentRequest, WalletView } from 'peal-links';
import { claimTestFunds, depositOnChain, ensureGas, LinksApiError, testFundsSource, tokenBalance, withdrawOnChain } from 'peal-links';
import type { Address, EIP1193Provider } from 'viem';
import { connectInjected, injectedProvider, onAuthChange, resumeInjected, session } from '../auth';
import { esc } from '../util';
import { describeError, formatUnits, fmtTime, parseUnits, shortHex } from '../links/format';
import {
  acknowledgeRecoveryCode,
  activate,
  client,
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

interface PageState {
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

let page: PageState = {
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
};

function requestUrl(id: string): string {
  return `${location.origin}/pay/${id}`;
}

function inviteUrl(address: string): string {
  return `${location.origin}/#/bonsai?invite=${address.toLowerCase()}`;
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

function connectButtons(): string {
  const injected = injectedProvider();
  return `<button type="button" class="pl-btn pl-btn-primary" id="pl-login">Connect wallet</button>${injected ? `<button type="button" class="pl-btn" id="pl-login-injected">Use browser wallet</button>` : ''}`;
}

/** The wallet panel: connect, continue, recover, or the active account. */
function walletPanel(): string {
  const l = links();
  const evm = session();
  if (!evm.address) {
    return `
      <div class="pl-panel">
        <div class="pl-panel-head"><h2 class="pl-panel-title">your wallet</h2></div>
        <div style="padding:14px 18px">
          <p class="pl-p">Your existing wallet is your payment identity here. Peal keeps a private account behind it: nothing to install, no second address to manage. Payments between Peal users hide the amount and the parties; deposits and withdrawals are public on the chain.</p>
          <div class="pl-actions" style="margin:0">${connectButtons()}</div>
        </div>
      </div>`;
  }
  const who = `<span class="pl-small">wallet <span class="pl-mono">${esc(shortHex(evm.address, 6, 4))}</span></span>`;
  if (l.account && page.view) {
    const v = page.view;
    return `
      <div class="pl-panel">
        <div class="pl-panel-head">
          <h2 class="pl-panel-title">${esc(page.displayName ?? shortHex(evm.address, 6, 4))}</h2>
          <div class="pl-actions" style="margin:0">${who}<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>private payments on</span><button type="button" class="pl-btn" id="pl-lock">Lock</button></div>
        </div>
        <div style="padding:14px 18px" class="pl-small">
          recovery: ${page.recovery === 'wallet-signature' ? 'your wallet signature opens your backup on any device' : 'your recovery code opens your backup on any device'}
          ${v.pending ? ` · <span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(v.pending)} pending</span>` : ''}
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button type="button" class="pl-btn" id="pl-rename">Change display name</button>
            <button type="button" class="pl-btn" id="pl-backup">Export backup file</button>
            <button type="button" class="pl-btn" id="pl-export-csv" title="a plaintext file of this account's receipts and payments">Export history (CSV)</button>
            <label class="pl-small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="pl-autoclaim" ${l.autoClaim ? 'checked' : ''}> claim incoming payments automatically while this page is open</label>
          </div>
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
        <p class="pl-p">This wallet already has private payments on Peal Links. Its backup is protected by the recovery code you saved when you set it up.</p>
        <form id="pl-recovery-code">
          <label class="pl-field"><span class="pl-label">recovery code</span><input class="pl-input pl-mono" name="code" required autocomplete="off" placeholder="PEAL-XXXXX-XXXXX-XXXXX-XXXXX"></label>
          <div class="pl-actions" style="margin:0"><button type="submit" class="pl-btn pl-btn-primary">Open my account</button><button type="button" class="pl-btn" id="pl-show-restore">Import a backup file instead</button></div>
        </form>`;
      break;
    case 'no-backup':
      body = `
        <div class="pl-notice pl-notice-warn">${esc(l.setupDetail ?? 'no backup is stored for this wallet')}</div>
        <div class="pl-actions" style="margin:0"><button type="button" class="pl-btn" id="pl-show-restore">Import a backup file</button></div>`;
      break;
    default:
      body = `
        <p class="pl-p">${l.hasStoredAccount ? 'Your private account is on this device. Continue to unlock it; no signature is needed.' : 'First time here: your wallet will confirm one Peal Links message that authorizes a private account for it, and one recovery message so the account can be recovered from any device.'}</p>
        ${l.setupDetail ? `<div class="pl-notice pl-notice-warn">${esc(l.setupDetail)}</div>` : ''}
        <div class="pl-actions" style="margin:0"><button type="button" class="pl-btn pl-btn-primary" id="pl-activate">Continue with this wallet</button><button type="button" class="pl-btn" id="pl-show-restore">Import a backup file</button></div>`;
  }
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">private payments</h2><div>${who}</div></div>
      <div style="padding:14px 18px">${body}</div>
    </div>`;
}

function recoveryCodeBanner(): string {
  const code = links().newRecoveryCode;
  if (!code) return '';
  return `
    <div class="pl-notice pl-notice-warn" role="alert">
      <strong>Save your recovery code now.</strong> Your wallet cannot derive a recovery key, so this code protects the backup of your private account. It is shown once and Peal never stores it; without it, a new browser cannot recover your balance.
      <div class="pl-share-link" style="margin-top:10px"><input class="pl-input pl-mono" readonly value="${esc(code)}" id="pl-code"><button type="button" class="pl-btn" data-copy="${esc(code)}">Copy</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pl-btn pl-btn-primary" id="pl-code-saved">I saved it</button></div>
    </div>`;
}

function restoreDialog(): string {
  return `
    <dialog class="pl-dialog" id="pl-restore-dialog">
      <form class="pl-dialog-body" id="pl-restore" method="dialog">
        <h3 class="pl-dialog-title">import a backup file</h3>
        <p class="pl-small">A backup file exported from Peal Links, protected by the recovery code you chose when exporting it. After importing, the account is checked against the ledger; a backup older than your last operation is reported as stale rather than used.</p>
        <label class="pl-field"><span class="pl-label">backup file</span><input class="pl-input" type="file" name="file" accept="application/json,.json" required></label>
        <label class="pl-field"><span class="pl-label">recovery code</span><input class="pl-input pl-mono" name="code" required autocomplete="off"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Import</button></div>
      </form>
    </dialog>`;
}

function balances(): string {
  const ns = links().namespace!;
  const v = page.view;
  const demo = ns.environment !== 'mainnet';
  const avail = formatUnits(v?.balance ?? '0', ns.decimals);
  const incoming = formatUnits(v?.unclaimed ?? '0', ns.decimals);
  const wallet = page.walletTokenBalance !== null ? formatUnits(page.walletTokenBalance, ns.decimals) : null;
  return `
    <div class="pl-balances">
      <div class="pl-balance">
        <div class="pl-balance-label"><span>wallet balance · public on ${esc(ns.chain_name)}</span>${demo ? `<span class="pl-badge pl-badge-demo">${esc(ns.environment)} funds</span>` : ''}</div>
        <div class="pl-balance-amount">${wallet ?? '—'}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-sub">${wallet !== null ? 'in your wallet; anyone can see it' : 'connect a wallet to see it'}${testFundsLink(ns)}</div>
      </div>
      <div class="pl-balance">
        <div class="pl-balance-label"><span>private balance · ${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-amount">${avail}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-sub">${v ? 'available: spendable now' : 'continue with your wallet to see it'}</div>
      </div>
      <div class="pl-balance">
        <div class="pl-balance-label"><span>incoming · verified, not yet claimed</span></div>
        <div class="pl-balance-amount">${incoming}<span class="pl-amount-unit">${esc(ns.token_symbol)}</span></div>
        <div class="pl-balance-sub">claiming adds it to available</div>
      </div>
    </div>`;
}

/** On a test namespace, where to get the asset: a button the app can act
 * on, or a link to an external faucet. */
function testFundsLink(ns: NamespaceInfo): string {
  const src = testFundsSource(ns);
  if (!src || !session().address) return '';
  if (src.kind === 'external') return ` · <a class="pl-linkbtn" href="${esc(src.url)}" target="_blank" rel="noreferrer">get testnet ${esc(ns.token_symbol)}</a>`;
  return ` · <button type="button" class="pl-linkbtn" id="pl-test-funds">get test ${esc(ns.token_symbol)}</button>`;
}

function actions(): string {
  const l = links();
  const active = !!l.account;
  const devMint = !!l.status?.dev_mint;
  const nsAvail = !!l.namespace?.available;
  const hasWallet = !!session().address;
  return `
    <div class="pl-actions">
      <button type="button" class="pl-btn pl-btn-primary" id="pl-new-request" ${active ? '' : 'disabled'} title="${active ? '' : 'continue with your wallet first'}">New payment link</button>
      <button type="button" class="pl-btn" id="pl-send" ${active ? '' : 'disabled'} title="${active ? '' : 'continue with your wallet first'}">Send to an address</button>
      ${
        nsAvail
          ? `<button type="button" class="pl-btn" id="pl-add-funds" ${active && hasWallet ? '' : 'disabled'}>Add funds</button>`
          : devMint
            ? `<button type="button" class="pl-btn" id="pl-dev-mint" ${active ? '' : 'disabled'} title="development fixture: credits test funds without a chain deposit">Add test funds (dev mint)</button>`
            : `<button type="button" class="pl-btn" disabled title="deposits are not available on this namespace">Add funds</button>`
      }
      ${
        nsAvail && l.status?.signer_mode !== 'none'
          ? `<button type="button" class="pl-btn" id="pl-withdraw" ${active && hasWallet ? '' : 'disabled'}>Withdraw</button>`
          : `<button type="button" class="pl-btn" disabled title="withdrawals are not available on this namespace">Withdraw</button>`
      }
    </div>`;
}

function invitePanel(): string {
  if (!page.invite) return '';
  const url = inviteUrl(page.invite);
  return `
    <div class="pl-notice pl-notice-warn" role="status" id="pl-invite">
      <strong>${esc(shortHex(page.invite, 6, 4))} has not activated private receiving on Peal Links yet.</strong> No funds were moved. Send them this invitation; once they connect their wallet and continue, you can pay them privately.
      <div class="pl-share-link" style="margin-top:10px"><input class="pl-input" readonly value="${esc(url)}" id="pl-invite-url"><button type="button" class="pl-btn" data-copy="${esc(url)}">Copy invitation</button></div>
      <div class="pl-actions" style="margin:10px 0 0"><button type="button" class="pl-btn" id="pl-invite-close">Close</button></div>
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
  const empty = l.account
    ? 'No payment links yet. A link is a fixed amount in one asset that anyone can pay you privately.'
    : 'Continue with your wallet to see and create your payment links.';
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">payment links</h2><span class="pl-small">${page.requests.length}</span></div>
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
        <span class="pl-list-main">${r.sender === MINT_SENDER ? 'deposit from your wallet' : 'private payment'}${r.reference && /^[a-z2-7]{24}$/.test(r.reference) ? ` · for link ${esc(r.reference.slice(0, 8))}…` : r.reference ? ` · ${esc(r.reference)}` : ''}</span>
        <span class="pl-list-sub">${receiptStatus(r.status)} · ${esc(fmtTime(r.discovered_at))}${r.status === 'unclaimed' ? ` · <button type="button" class="pl-linkbtn" data-claim="${v.receipts.length - 1 - i}">claim now</button>` : ''}</span>
        <span class="pl-list-side">${formatUnits(r.amount, ns.decimals)} ${esc(ns.token_symbol)}</span>
      </li>`,
    )
    .join('');
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">incoming</h2><span class="pl-small">${v.receipts.length}</span></div>
      ${rows ? `<ul class="pl-list">${rows}</ul>` : `<div class="pl-empty">Payments addressed to you appear here as soon as they reach you, and become available once claimed (automatically while this page is open).</div>`}
    </div>`;
}

function activityPanel(): string {
  const ns = links().namespace!;
  const v = page.view;
  if (!v) return '';
  const rows = v.history
    .slice()
    .reverse()
    .map((h) => {
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
      return `<li>
        <span class="pl-list-main">${main}</span>
        <span class="pl-list-sub">${esc(fmtTime(h.at))}</span>
        <span class="pl-list-side">${h.kind === 'send' ? '−' : '+'}${formatUnits(h.amount, ns.decimals)} ${esc(ns.token_symbol)}</span>
      </li>`;
    })
    .join('');
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">activity</h2><span class="pl-small">decrypted on this device</span></div>
      ${rows ? `<ul class="pl-list">${rows}</ul>` : `<div class="pl-empty">Deposits, payments sent and received, and withdrawals appear here.</div>`}
    </div>`;
}

function ledgerPanel(): string {
  const s = links().status!;
  return `
    <div class="pl-panel">
      <div class="pl-panel-head"><h2 class="pl-panel-title">ledger</h2><span class="pl-small">${esc(s.ledger_mode)}${s.consensus ? ` · height ${s.consensus.height} · state <span class="pl-mono">${esc(s.consensus.state_root.slice(0, 12))}…</span>` : ''} · circuit <span class="pl-mono">${esc(s.circuit_id.slice(0, 12))}…</span></span></div>
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
        <label class="pl-field"><span class="pl-label">reference (optional)</span><input class="pl-input" name="reference" maxlength="64" placeholder="INV-0417"></label>
        <label class="pl-field"><span class="pl-label">expires (optional)</span><input class="pl-input" name="expires" type="datetime-local"></label>
        <p class="pl-small">The title, amount, your display name and your wallet address are visible to anyone holding the link. Keep sensitive details out of them.</p>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Create link</button></div>
      </form>
    </dialog>`;
}

function sendDialog(): string {
  const ns = links().namespace!;
  return `
    <dialog class="pl-dialog" id="pl-send-dialog">
      <form class="pl-dialog-body" id="pl-send-form" method="dialog">
        <h3 class="pl-dialog-title">send to an address</h3>
        <p class="pl-small">Enter a wallet address that uses Peal Links. Their receiving details are looked up and verified against their wallet's signature on this device; the payment itself hides the amount and the parties. Your wallet confirms the payment; nothing else leaves your browser but the proof and an encrypted receipt.</p>
        <label class="pl-field"><span class="pl-label">recipient wallet address on ${esc(ns.chain_name)}</span><input class="pl-input pl-mono" name="to" required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…"></label>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)}${page.view ? `, available ${formatUnits(page.view.balance, ns.decimals)}` : ''})</span><input class="pl-input" name="amount" inputmode="decimal" required placeholder="0.00"></label>
        <label class="pl-field"><span class="pl-label">note for the recipient (optional)</span><input class="pl-input" name="reference" maxlength="64" placeholder="thanks for lunch"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Continue</button></div>
      </form>
    </dialog>`;
}

function renameDialog(): string {
  return `
    <dialog class="pl-dialog" id="pl-rename-dialog">
      <form class="pl-dialog-body" id="pl-rename-form" method="dialog">
        <h3 class="pl-dialog-title">display name</h3>
        <p class="pl-small">Shown next to your wallet address on your payment links. It is a name you chose, not an identity check; your wallet confirms the change.</p>
        <label class="pl-field"><span class="pl-label">display name</span><input class="pl-input" name="display" maxlength="60" required value="${esc(page.displayName ?? '')}"></label>
        <div class="pl-dialog-actions"><button type="button" class="pl-btn" data-close>Cancel</button><button type="submit" class="pl-btn pl-btn-primary">Save</button></div>
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
        <p class="pl-small">A public deposit of ${esc(ns.token_symbol)} from your wallet <span class="pl-mono">${esc(shortHex(evm.address ?? '', 6, 4))}</span> into the gateway on ${esc(ns.chain_name)}${page.walletTokenBalance !== null ? ` (wallet holds ${formatUnits(page.walletTokenBalance, ns.decimals)} ${esc(ns.token_symbol)})` : ''}. Two wallet confirmations: approve, then deposit. Credited to your private balance after ${ns.confirmations} block${ns.confirmations === 1 ? '' : 's'}; the amount and your address are visible on the chain, what happens inside Peal afterwards is not.</p>
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
        <p class="pl-small">The amount leaves your private balance with a proof, then ${s.signer_threshold} of ${s.signers.length} settlement signers attest to its release and the gateway pays the recipient. This is a committee-attested bridge${s.signer_mode === 'single-process-fixture' ? ' and, on this node, the signers are a single-process fixture' : s.signer_mode === 'one-key-per-validator' ? ' and, on this stack, each local validator process holds one signer key' : ''}: a compromised committee could release funds wrongly. The withdrawal, its amount and the recipient are public on the chain.</p>
        <label class="pl-field"><span class="pl-label">amount (${esc(ns.token_symbol)}${v ? `, available ${formatUnits(v.balance, ns.decimals)}` : ''})</span><input class="pl-input" name="amount" inputmode="decimal" required placeholder="0.00"></label>
        <label class="pl-field"><span class="pl-label">to wallet address on ${esc(ns.chain_name)}</span><input class="pl-input pl-mono" name="recipient" required pattern="0x[0-9a-fA-F]{40}" value="${esc(session().address ?? '')}"><div class="pl-hint">your connected wallet by default; it confirms the release</div></label>
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
            (w) => `<li><span class="pl-list-main">to ${esc(shortHex(w.recipient, 6, 4))}</span><span class="pl-list-sub">${w.status === 'confirmed' ? `<span class="pl-status pl-status-ok"><span class="pl-status-dot"></span>confirmed on chain</span>` : `<span class="pl-status pl-status-pending"><span class="pl-status-dot"></span>${esc(w.status.replace('_', ' '))}</span>`}${w.tx_hash ? ` · tx <span class="pl-mono">${esc(shortHex(w.tx_hash, 8, 6))}</span>` : ''}</span><span class="pl-list-side">${formatUnits(w.amount, ns.decimals)} ${esc(ns.token_symbol)}</span></li>`,
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
        ${recoveryCodeBanner()}
        ${walletPanel()}
        ${balances()}
        ${actions()}
        ${invitePanel()}
        ${requestsPanel()}
        ${receiptsPanel()}
        ${withdrawalsPanel()}
        ${activityPanel()}
        ${ledgerPanel()}
        ${restoreDialog()}
        ${newRequestDialog()}
        ${sendDialog()}
        ${renameDialog()}
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
  page = { view: null, labels: {}, displayName: null, recovery: null, requests: [], busy: null, error: null, notice: null, lastLink: null, invite: null, walletTokenBalance: null, withdrawals: [] };
  MINT_SENDER = localStorage.getItem(MINT_SENDER_KEY) ?? '';
  // An invitation link (#/bonsai?invite=0x…) lands here: say what it is.
  const invited = /[?&]invite=(0x[0-9a-fA-F]{40})/.exec(location.hash);
  if (invited) page.notice = `Someone wants to pay you privately on Peal Links. Connect the wallet ${shortHex(invited[1]!, 6, 4)} and continue; they can pay you once your wallet has private receiving.`;

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
    paint();
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

  root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button, a');
    if (!btn) return;
    const l = links();
    if (btn.id === 'pl-login') session().login();
    else if (btn.id === 'pl-login-injected') void run('connecting browser wallet', async () => void (await connectInjected()));
    else if (btn.id === 'pl-activate') void doActivate();
    else if (btn.id === 'pl-test-funds') {
      const ns = l.namespace!;
      const evm = session();
      void run(`getting test ${ns.token_symbol} for your wallet`, async () => {
        const how = await claimTestFunds(ns, evm.provider as unknown as EIP1193Provider, evm.address as Address);
        await refreshWalletBalance();
        page.notice = how === 'chain-faucet' ? `${ns.chain_name} funded your wallet with ${ns.token_symbol}.` : `The test token's faucet sent 1,000 ${ns.token_symbol} to your wallet.`;
      });
    }
    else if (btn.id === 'pl-code-saved') {
      acknowledgeRecoveryCode();
      paint();
    } else if (btn.id === 'pl-lock') {
      lockAccount();
      page.view = null;
      paint();
    } else if (btn.id === 'pl-show-restore') root.querySelector<HTMLDialogElement>('#pl-restore-dialog')?.showModal();
    else if (btn.id === 'pl-new-request') root.querySelector<HTMLDialogElement>('#pl-request-dialog')?.showModal();
    else if (btn.id === 'pl-send') root.querySelector<HTMLDialogElement>('#pl-send-dialog')?.showModal();
    else if (btn.id === 'pl-rename') root.querySelector<HTMLDialogElement>('#pl-rename-dialog')?.showModal();
    else if (btn.id === 'pl-dev-mint') root.querySelector<HTMLDialogElement>('#pl-mint-dialog')?.showModal();
    else if (btn.id === 'pl-add-funds') root.querySelector<HTMLDialogElement>('#pl-fund-dialog')?.showModal();
    else if (btn.id === 'pl-withdraw') root.querySelector<HTMLDialogElement>('#pl-withdraw-dialog')?.showModal();
    else if (btn.id === 'pl-invite-close') {
      page.invite = null;
      paint();
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
    if (form.id === 'pl-recovery-code') {
      void run('opening your backup with the recovery code', async () => {
        await recoverWithCode(String(data.get('code') ?? ''));
        page.notice = 'Your private account is back on this device.';
      });
    } else if (form.id === 'pl-restore') {
      const file = data.get('file') as File | null;
      if (!file) return;
      form.closest('dialog')?.close();
      void run('importing and checking against the ledger', async () => {
        const json = await file.text();
        const account = await restoreFile(json, String(data.get('code') ?? ''));
        const r = await account.reconcile();
        page.notice = r === 'conflict' ? 'Imported, but this backup is older than the account on the ledger. Do not use it to pay; import a newer backup.' : 'Imported from the backup file.';
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
      });
    } else if (form.id === 'pl-send-form') {
      const ns = l.namespace!;
      const to = String(data.get('to') ?? '').trim();
      const amount = parseUnits(String(data.get('amount') ?? ''), ns.decimals);
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        page.error = 'enter a wallet address and an amount';
        paint();
        return;
      }
      form.closest('dialog')?.close();
      page.invite = null;
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
      form.closest('dialog')?.close();
      void run('confirm the new display name in your wallet', async () => {
        await rename(l.account!, name);
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
      void run('adding funds: proving the deposit intent, then confirm the approval and the deposit in your wallet', async () => {
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
      if (!amount || amount === '0' || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || !evm.address || !evm.provider) {
        page.error = 'enter an amount, a recipient address, and connect a wallet';
        paint();
        return;
      }
      form.closest('dialog')?.close();
      void run('withdrawal: proving on this device (about 7 s), then the committee certificate, then confirm the release in your wallet', async () => {
        const { certificate } = await l.account!.withdraw(amount, recipient);
        await ensureGas(ns, evm.address as Address);
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
        page.notice = 'Test funds credited under incoming. They become available once claimed.';
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
    document.title = previousTitle;
  };
}

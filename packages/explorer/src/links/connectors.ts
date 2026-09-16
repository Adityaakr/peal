// The wallet chooser shown wherever Peal Links asks for a wallet: the pay
// page and the dashboard. Both connectors are always listed so a payer sees
// the choice at a glance. A browser wallet (MetaMask, Rabby and friends)
// spends the funds the person already holds; the Privy wallet is an
// embedded wallet behind an email sign-in for people without an extension.
// Either one ends up in the same session state, so the rest of the product
// never needs to know which was picked.
import { injectedProvider, session } from '../auth';
import { shortHex } from './format';
import { esc } from '../util';

/** Two option cards. `prefix` namespaces the button ids per page
 * (`pay-login-injected` / `pay-login`, `pl-login-injected` / `pl-login`). */
export function connectorChoices(prefix: string): string {
  const injected = injectedProvider() !== null;
  const browserHint = injected
    ? 'MetaMask, Rabby or another extension · pays with the funds you already hold'
    : 'no wallet extension detected in this browser';
  return `
    <div class="pl-connectors" role="group" aria-label="choose a wallet">
      <button type="button" class="pl-connector" id="${prefix}-login-injected" aria-label="Use browser wallet"${injected ? '' : ' disabled'}>
        <span class="pl-connector-name">Browser wallet</span>
        <span class="pl-connector-hint">${esc(browserHint)}</span>
      </button>
      <button type="button" class="pl-connector" id="${prefix}-login" aria-label="Use Privy wallet">
        <span class="pl-connector-name">Privy wallet</span>
        <span class="pl-connector-hint">sign in with email · an embedded wallet, nothing to install</span>
      </button>
    </div>`;
}

/** "browser wallet 0x1234…abcd" or "Privy wallet 0x…" for the connected session. */
export function connectorLine(): string {
  const evm = session();
  if (!evm.address) return '';
  return `${evm.source === 'privy' ? 'Privy wallet' : 'browser wallet'} <span class="pl-mono">${esc(shortHex(evm.address, 6, 4))}</span>`;
}

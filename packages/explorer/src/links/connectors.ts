// The wallet chooser shown wherever Peal Private Links asks for a wallet:
// the pay page and the dashboard. One connector: a browser wallet
// (MetaMask, Rabby and friends), which spends the funds the person already
// holds. Privy's embedded wallet stays wired in the session module for the
// rest of the site, but Peal Private Links no longer offers it.
import { injectedProvider, session } from '../auth';
import { shortHex } from './format';
import { esc } from '../util';

/** The browser wallet card. `prefix` namespaces the button id per page
 * (`pay-login-injected`, `pl-login-injected`). When no extension is
 * present the card says so and points at one. */
export function connectorChoices(prefix: string): string {
  const injected = injectedProvider() !== null;
  return `
    <div class="pl-connectors pl-connectors-one" role="group" aria-label="connect a wallet">
      <button type="button" class="pl-connector" id="${prefix}-login-injected" aria-label="Use browser wallet"${injected ? '' : ' disabled'}>
        <span class="pl-connector-name">${injected ? 'Connect browser wallet' : 'No browser wallet found'}</span>
        <span class="pl-connector-hint">${injected ? 'MetaMask, Rabby or another extension · pays with the funds you already hold' : 'install a wallet extension such as MetaMask, then reload this page'}</span>
      </button>
      ${injected ? '' : `<a class="pl-connector-alt" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get MetaMask</a>`}
    </div>`;
}

/** "browser wallet 0x1234…abcd" or "Privy wallet 0x…" for the connected session. */
export function connectorLine(): string {
  const evm = session();
  if (!evm.address) return '';
  return `${evm.source === 'privy' ? 'Privy wallet' : 'browser wallet'} <span class="pl-mono">${esc(shortHex(evm.address, 6, 4))}</span>`;
}

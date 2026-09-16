// Sign-in with Privy, bridged into pages that are not React.
//
// The auction pages build their DOM directly, and Privy's SDK only exists as
// React hooks. Rather than rewrite those pages, a single React root is mounted
// once, outside the router's element so navigation never unmounts it, and a
// small bridge component publishes what it knows into the module-level state
// below. Vanilla code reads `session()` and subscribes with `onAuthChange`.
//
// The alternative was `window.ethereum` everywhere, which is what the pages did
// before. That requires a browser extension, which is the single biggest reason
// someone bounces off a testnet demo.
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ACTIVE, CHAIN_FOR, TEMPO } from 'peal-auctionkit';
import type { Address } from 'viem';

/** Just the method the pages use.
 *
 * Privy's EIP1193Provider and viem's disagree on the `on` signature, and
 * neither of those types is worth importing here: every call site does
 * `request({ method, params })` and nothing else. Narrowing to that is honest
 * about what is actually depended on, and it is what viem's `custom()`
 * transport wants anyway. */
export interface Eip1193Like {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

const APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string) || 'cmtbxp6kx00840djxgnhx59gh';

export interface Session {
  ready: boolean;
  /** Which connector produced `address`: Privy's embedded wallet or an
   * injected browser wallet. Privy's bridge only ever clears its own. */
  source: 'privy' | 'injected' | null;
  address: Address | null;
  provider: Eip1193Like | null;
  /** Which chain the wallet is actually on. An embedded wallet starts on
   * whatever `defaultChain` says, and a user's existing extension starts
   * wherever they left it, so this is never assumed. */
  chainId: number | null;
  login: () => void;
  logout: () => void;
  /** Move the wallet to `chainId`. Resolves once it is there.
   *
   * Every write has to call this first. Privy refuses a transaction whose
   * target chain differs from the wallet's current one, with exactly the error
   * a user saw here: "The current chain of the wallet (id: 1) does not match
   * the target chain for the transaction (id: 560048)". */
  switchChain: (chainId: number) => Promise<void>;
}

let state: Session = {
  ready: false,
  source: null,
  address: null,
  provider: null,
  chainId: null,
  login: () => {},
  logout: () => {},
  switchChain: async () => {},
};

const listeners = new Set<() => void>();

export function session(): Session {
  return state;
}

/** An EIP-1193 provider injected by a browser wallet extension, if any. */
export function injectedProvider(): Eip1193Like | null {
  const eth = (window as unknown as { ethereum?: Eip1193Like }).ethereum;
  return eth && typeof eth.request === 'function' ? eth : null;
}

/** Connect an injected browser wallet (MetaMask and friends) instead of
 * Privy. Peal Links offers this because a payer who already has a wallet
 * with funds should not have to create an embedded one; every signature
 * still goes through the wallet's own confirmation. Publishes into the same
 * session state the Privy bridge uses, so pages need not know which one is
 * active. */
export async function connectInjected(): Promise<Address> {
  const provider = injectedProvider();
  if (!provider) throw new Error('no browser wallet found');
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0] as Address | undefined;
  if (!address) throw new Error('the wallet returned no account');
  const chainHex = (await provider.request({ method: 'eth_chainId' })) as string;
  publish({
    ready: true,
    source: 'injected',
    address,
    provider,
    chainId: Number.parseInt(chainHex, 16),
    logout: () => publish({ source: null, address: null, provider: null, chainId: null }),
    switchChain: async (id: number) => {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${id.toString(16)}` }] });
      publish({ chainId: id });
    },
  });
  return address;
}

/** Subscribe to sign-in changes. Returns an unsubscribe. */
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(next: Partial<Session>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

/** Renders nothing. It exists to turn hook state into module state. */
function Bridge(): null {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    publish({ ready, login, logout });
  }, [ready, login, logout]);

  useEffect(() => {
    if (!authenticated) {
      // Privy signing out (or never signed in) must not disconnect a wallet
      // the person connected through the browser instead.
      if (state.source === 'privy') publish({ source: null, address: null, provider: null });
      return;
    }
    // Prefer the embedded wallet. A user who also has an extension connected
    // should still transact with the wallet this app created and funded,
    // otherwise the funding lands somewhere they are not spending from.
    const wallet =
      wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
    if (!wallet) return;

    // `chainId` on a Privy wallet is CAIP-2, "eip155:1", not a number.
    const currentChain = (): number | null => {
      const raw = wallet.chainId;
      if (typeof raw === 'number') return raw;
      const m = /(?:eip155:)?(\d+)$/.exec(String(raw ?? ''));
      return m ? Number(m[1]) : null;
    };

    let cancelled = false;
    void wallet.getEthereumProvider().then((provider) => {
      if (cancelled) return;
      publish({
        source: 'privy',
        address: wallet.address as Address,
        provider: provider as Eip1193Like,
        chainId: currentChain(),
        switchChain: async (id: number) => {
          if (currentChain() === id) return;
          await wallet.switchChain(id);
          publish({ chainId: id });
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated, wallets, user]);

  return null;
}

/** Mount once, at startup. Idempotent. */
export function mountAuth(): void {
  if (document.getElementById('privy-root')) return;
  const host = document.createElement('div');
  host.id = 'privy-root';
  document.body.appendChild(host);

  createRoot(host).render(
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Everyone gets a wallet, including people who arrived with an
        // extension. The app funds the wallet it created, so that is the one
        // that has to be able to pay.
        embeddedWallets: {
          // Nested per chain in v3, not top level.
          ethereum: { createOnLogin: 'all-users' },
          // No confirmation modal per signature. The whole point is that a
          // bidder places a sealed bid without three dialogs, and an embedded
          // wallet the app provisioned has nothing meaningful to confirm
          // against: the user already consented by signing in.
          showWalletUIs: false,
        },
        // Email only. Google and "continue with a wallet" were removed from the
        // dialog: the app provisions the wallet, so a person brings nothing.
        loginMethods: ['email'],
        // Without this an embedded wallet lands on Ethereum mainnet and every
        // transaction is refused for targeting the wrong chain.
        //
        // The default follows ACTIVE rather than being written out, so moving
        // the app between chains cannot leave new wallets provisioned on the
        // old one. Both stay supported, so a link to an auction on the other
        // chain still works.
        supportedChains: [CHAIN_FOR[TEMPO.chainId]!],
        defaultChain: CHAIN_FOR[ACTIVE.chainId]!,
        appearance: { theme: 'light', accentColor: '#2563eb' },
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );
}

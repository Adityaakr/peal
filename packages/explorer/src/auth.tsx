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
  address: Address | null;
  provider: Eip1193Like | null;
  login: () => void;
  logout: () => void;
}

let state: Session = {
  ready: false,
  address: null,
  provider: null,
  login: () => {},
  logout: () => {},
};

const listeners = new Set<() => void>();

export function session(): Session {
  return state;
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
      publish({ address: null, provider: null });
      return;
    }
    // Prefer the embedded wallet. A user who also has an extension connected
    // should still transact with the wallet this app created and funded,
    // otherwise the funding lands somewhere they are not spending from.
    const wallet =
      wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
    if (!wallet) return;

    let cancelled = false;
    void wallet.getEthereumProvider().then((provider) => {
      if (cancelled) return;
      publish({ address: wallet.address as Address, provider: provider as Eip1193Like });
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
        loginMethods: ['email', 'google', 'wallet'],
        appearance: { theme: 'light', accentColor: '#2563eb' },
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );
}

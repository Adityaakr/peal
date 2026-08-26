// AuctionKit: the /auction section — a live sealed-bid auction on Ethereum Hoodi.
//
// This page places a real bid on a real chain. Everything it shows is read from
// the auction contract; nothing is mocked, and there is no simulated mode to
// fall back to when a call fails, because a page that pretends a transaction
// worked is worse than one that says it could not reach the chain.
//
// What is honestly private here, and what is not:
//
//   - HIDDEN until the auction closes: the split between quantity and price.
//     The chain sees one commitment hash and nothing about what is inside it.
//   - VISIBLE immediately: the escrow. It is an ERC-20 transfer of
//     quantity x maxPrice, so anyone watching sees that product. They cannot
//     separate the factors, but a distinctive amount is a fingerprint.
//
// The page says so, in those words. Claiming bid-size privacy would need
// shielded funding, which is not implemented.
import {
  AuctionState,
  HOODI,
  HOODI_DEMO,
  STATE_LABELS,
  allocationFor,
  findClearingTick,
  prepareBid,
  priceAt,
  priceLadder,
  readAuction,
  submitBid,
  DemoTokenAbi,
  type AuctionSnapshot,
  type PreparedBid,
} from 'peal-auctionkit';
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { esc, truncMiddle } from '../util';

type Cleanup = () => void;

const RPC = 'https://rpc.hoodi.ethpandaops.io';
const CHAIN = {
  id: HOODI.chainId,
  name: HOODI.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

/** Bids live in localStorage because the salt exists nowhere else.
 *
 * Losing it means the bid can never be revealed: the commitment cannot be
 * reproduced, the reveal is voided, and the bidder gets a refund and no
 * allocation. That is the single most important thing this page persists, so
 * it is also offered as a downloadable file. */
const STORE_KEY = 'peal.auctionkit.bids.v1';

interface SavedBid {
  chainId: number;
  auction: Address;
  bidder: Address;
  bidId: number;
  quantity: string;
  maxPriceTick: number;
  salt: Hex;
  bidVersion: number;
  commitment: Hex;
  escrow: string;
  txHash: Hex;
  at: number;
}

function loadBids(): SavedBid[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as SavedBid[]) : [];
  } catch {
    return [];
  }
}

function saveBid(b: SavedBid): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...loadBids(), b]));
  } catch {
    /* private browsing, quota — the page still works, the receipt download is
       the durable copy. */
  }
}

function ethereum(): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null {
  const w = window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } };
  return w.ethereum ?? null;
}

function fmt(v: bigint, decimals: number, places = 4): string {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, places).replace(/0+$/, '') || '0'}` : i!;
}

function countdown(toSec: bigint, nowSec: bigint): string {
  let d = Number(toSec - nowSec);
  if (d <= 0) return 'closed';
  const h = Math.floor(d / 3600);
  d -= h * 3600;
  const m = Math.floor(d / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${d - m * 60}s`;
}

export function renderAuction(root: HTMLElement): Cleanup {
  let stopped = false;
  let account: Address | null = null;
  let snap: AuctionSnapshot | null = null;
  let quoteBalance = 0n;
  let status = '';
  let statusKind: 'info' | 'error' | 'ok' = 'info';
  let busy = false;

  root.innerHTML = `<section class="ak"><h1>Sealed-bid auction</h1><p class="ak-sub">Loading from ${esc(HOODI.name)}…</p></section>`;

  async function refresh(): Promise<void> {
    try {
      snap = await readAuction(pub, HOODI_DEMO.auction);
      if (account) {
        quoteBalance = (await pub.readContract({
          address: HOODI_DEMO.quoteToken,
          abi: DemoTokenAbi,
          functionName: 'balanceOf',
          args: [account],
        })) as bigint;
      }
    } catch (e) {
      status = `Could not reach ${HOODI.name}: ${(e as Error).message}`;
      statusKind = 'error';
    }
    if (!stopped) draw();
  }

  async function connect(): Promise<void> {
    const eth = ethereum();
    if (!eth) {
      status = 'No injected wallet found. Install MetaMask or another EIP-1193 wallet.';
      statusKind = 'error';
      draw();
      return;
    }
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
      account = accounts[0] ?? null;

      // Switch, or add the chain if the wallet has never seen Hoodi.
      const hexChain = `0x${HOODI.chainId.toString(16)}`;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
      } catch {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexChain,
            chainName: HOODI.name,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [RPC],
            blockExplorerUrls: [HOODI.explorer],
          }],
        });
      }
      status = '';
      await refresh();
    } catch (e) {
      status = (e as Error).message;
      statusKind = 'error';
      draw();
    }
  }

  async function placeBid(quantityStr: string, tick: number): Promise<void> {
    if (!snap || !account || busy) return;
    const eth = ethereum();
    if (!eth) return;
    busy = true;
    status = 'Preparing bid locally…';
    statusKind = 'info';
    draw();

    try {
      const quantity = parseUnits(quantityStr, snap.config.saleDecimals);
      const bid: PreparedBid = prepareBid({
        cfg: snap.config,
        chainId: HOODI.chainId,
        auction: HOODI_DEMO.auction,
        bidder: account,
        quantity,
        maxPriceTick: tick,
      });

      if (bid.escrow > quoteBalance) {
        throw new Error(
          `Escrow needs ${fmt(bid.escrow, snap.config.quoteDecimals)} ${HOODI_DEMO.quoteSymbol}, ` +
            `you hold ${fmt(quoteBalance, snap.config.quoteDecimals)}.`,
        );
      }

      const wallet = createWalletClient({ account, chain: CHAIN, transport: custom(eth) });
      status = 'Approve the escrow, then confirm the bid…';
      draw();

      const res = await submitBid({
        publicClient: pub,
        walletClient: wallet,
        account,
        auction: HOODI_DEMO.auction,
        quoteToken: HOODI_DEMO.quoteToken,
        bid,
        // Stands in for the Peal ciphertext hash until sealing is wired in.
        // Registered onchain so ciphertext loss stays provable and attributable.
        ciphertextHash: keccak256(stringToHex(`${account}:${bid.salt}`)),
      });

      saveBid({
        chainId: HOODI.chainId,
        auction: HOODI_DEMO.auction,
        bidder: account,
        bidId: res.bidId,
        quantity: quantity.toString(),
        maxPriceTick: tick,
        salt: bid.salt,
        bidVersion: bid.bidVersion,
        commitment: bid.commitment,
        escrow: bid.escrow.toString(),
        txHash: res.commitTx,
        at: Math.floor(Date.now() / 1000),
      });

      status = `Bid #${res.bidId} committed. Save your salt — without it the bid cannot be revealed.`;
      statusKind = 'ok';
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      status = m.length > 300 ? `${m.slice(0, 300)}…` : m;
      statusKind = 'error';
    } finally {
      busy = false;
      await refresh();
    }
  }

  function downloadBids(): void {
    const blob = new Blob([JSON.stringify(loadBids(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'peal-auction-bids.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function draw(): void {
    if (!snap) {
      root.innerHTML = `<section class="ak"><h1>Sealed-bid auction</h1>
        <p class="ak-status ak-error">${esc(status || 'Loading…')}</p></section>`;
      return;
    }
    const c = snap.config;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const ladder = priceLadder(c);
    const mine = loadBids().filter(
      (b) => b.auction.toLowerCase() === HOODI_DEMO.auction.toLowerCase() &&
        (!account || b.bidder.toLowerCase() === account.toLowerCase()),
    );

    // Predicted outcome, from the bidder's OWN saved bids only. The page cannot
    // know anyone else's until the auction closes — that is the product — so
    // this is explicitly labelled as a partial view, not a leaderboard.
    let prediction = '';
    if (snap.state === AuctionState.Settled && mine.length) {
      const rows = mine.map((b) => {
        const alloc = pub && snap!.clearingPrice > 0n
          ? allocationFor(
              findClearingTick(
                Array.from({ length: c.numTicks }, (_, t) =>
                  mine.filter((x) => x.maxPriceTick === t).reduce((s, x) => s + BigInt(x.quantity), 0n)),
                c.totalSupply,
              ),
              BigInt(b.quantity),
              b.maxPriceTick,
            )
          : 0n;
        return `<li>Bid #${b.bidId}: settled — check <code>allocationOf(${b.bidId})</code> onchain (local estimate ${fmt(alloc, c.saleDecimals)})</li>`;
      });
      prediction = `<ul class="ak-list">${rows.join('')}</ul>`;
    }

    root.innerHTML = `
<section class="ak">
  <header class="ak-head">
    <div>
      <h1>Sealed-bid auction</h1>
      <p class="ak-sub">
        Live on <a href="${HOODI.explorer}/address/${HOODI_DEMO.auction}" target="_blank" rel="noopener">${esc(HOODI.name)}</a>
        · <code>${esc(truncMiddle(HOODI_DEMO.auction, 8, 6))}</code>
      </p>
    </div>
    <div class="ak-state ak-state-${snap.state}">${esc(STATE_LABELS[snap.state] ?? String(snap.state))}</div>
  </header>

  <div class="ak-grid">
    <div class="ak-card"><span>For sale</span><strong>${fmt(c.totalSupply, c.saleDecimals, 0)} ${esc(HOODI_DEMO.saleSymbol)}</strong></div>
    <div class="ak-card"><span>Reserve</span><strong>${fmt(c.reservePrice, c.quoteDecimals)} ${esc(HOODI_DEMO.quoteSymbol)}</strong></div>
    <div class="ak-card"><span>Bids committed</span><strong>${snap.committedBidCount}</strong></div>
    <div class="ak-card"><span>${snap.biddingOpen ? 'Bidding closes in' : 'Bidding'}</span><strong>${esc(countdown(c.endTime, now))}</strong></div>
  </div>

  <div class="ak-privacy">
    <strong>What is hidden, and what is not.</strong>
    Your quantity and price are hidden until the auction closes — the chain sees only a commitment hash.
    Your <em>escrow</em> is not: it is a visible token transfer of quantity × your maximum price.
    Nobody can separate those two factors, but the amount itself is public.
    This is not bid-size privacy, and AuctionKit does not claim it is.
  </div>

  ${account
    ? `<div class="ak-acct">Connected <code>${esc(truncMiddle(account, 6, 4))}</code>
         · ${fmt(quoteBalance, c.quoteDecimals, 2)} ${esc(HOODI_DEMO.quoteSymbol)}</div>`
    : `<button class="ak-btn ak-primary" id="ak-connect">Connect wallet</button>`}

  ${status ? `<p class="ak-status ak-${statusKind}">${esc(status)}</p>` : ''}

  ${account && snap.biddingOpen ? `
  <form class="ak-form" id="ak-form">
    <label>Quantity (${esc(HOODI_DEMO.saleSymbol)})
      <input id="ak-qty" type="text" inputmode="decimal" value="100" autocomplete="off" />
    </label>
    <label>Maximum price you will pay
      <select id="ak-tick">
        ${ladder.map((l) => `<option value="${l.tick}"${l.tick === 5 ? ' selected' : ''}>${fmt(l.price, c.quoteDecimals)} ${esc(HOODI_DEMO.quoteSymbol)}</option>`).join('')}
      </select>
    </label>
    <p class="ak-hint" id="ak-escrow"></p>
    <button class="ak-btn ak-primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Place sealed bid'}</button>
    <p class="ak-hint">You pay the <em>clearing</em> price, never your maximum. Bidding your true value cannot make you overpay.</p>
  </form>` : ''}

  ${account && !snap.biddingOpen && snap.state === AuctionState.CommitOpen
    ? `<p class="ak-status ak-info">Bidding has ended for this auction.</p>` : ''}

  ${mine.length ? `
  <h2>Your bids</h2>
  <p class="ak-hint">Stored in this browser only. The <strong>salt</strong> exists nowhere else — lose it and the bid cannot be revealed, and you get a refund instead of an allocation.</p>
  <table class="ak-table">
    <thead><tr><th>#</th><th>Quantity</th><th>Max price</th><th>Escrow</th><th>Tx</th></tr></thead>
    <tbody>${mine.map((b) => `<tr>
      <td>${b.bidId}</td>
      <td>${fmt(BigInt(b.quantity), c.saleDecimals, 2)}</td>
      <td>${fmt(priceAt(c.reservePrice, c.tickSize, b.maxPriceTick), c.quoteDecimals)}</td>
      <td>${fmt(BigInt(b.escrow), c.quoteDecimals, 2)}</td>
      <td><a href="${HOODI.explorer}/tx/${b.txHash}" target="_blank" rel="noopener">${esc(truncMiddle(b.txHash, 6, 4))}</a></td>
    </tr>`).join('')}</tbody>
  </table>
  <button class="ak-btn" id="ak-download">Download bids + salts</button>
  ${prediction}` : ''}

  <p class="ak-foot">
    Testnet demo. The reveal committee's signing keys are <strong>publicly derivable</strong>
    (see <code>DeployDemoAuction.s.sol</code>) — it is a prop, not custody.
    Implementation <code>${esc(truncMiddle(HOODI.auctionImplementation, 8, 6))}</code>.
  </p>
</section>`;

    root.querySelector('#ak-connect')?.addEventListener('click', () => void connect());
    root.querySelector('#ak-download')?.addEventListener('click', downloadBids);

    const qty = root.querySelector<HTMLInputElement>('#ak-qty');
    const tickSel = root.querySelector<HTMLSelectElement>('#ak-tick');
    const escrowEl = root.querySelector<HTMLElement>('#ak-escrow');

    const updateEscrow = (): void => {
      if (!qty || !tickSel || !escrowEl || !snap) return;
      try {
        const q = parseUnits(qty.value || '0', snap.config.saleDecimals);
        const t = Number(tickSel.value);
        const bid = prepareBid({
          cfg: snap.config, chainId: HOODI.chainId, auction: HOODI_DEMO.auction,
          bidder: account!, quantity: q, maxPriceTick: t,
        });
        escrowEl.textContent =
          `Escrow: ${fmt(bid.escrow, snap.config.quoteDecimals, 2)} ${HOODI_DEMO.quoteSymbol}` +
          (bid.escrow > quoteBalance ? ' — more than you hold' : '');
        escrowEl.className = bid.escrow > quoteBalance ? 'ak-hint ak-error' : 'ak-hint';
      } catch (e) {
        escrowEl.textContent = (e as Error).message;
        escrowEl.className = 'ak-hint ak-error';
      }
    };
    qty?.addEventListener('input', updateEscrow);
    tickSel?.addEventListener('change', updateEscrow);
    updateEscrow();

    root.querySelector('#ak-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (qty && tickSel) void placeBid(qty.value, Number(tickSel.value));
    });
  }

  void refresh();
  const timer = window.setInterval(() => void refresh(), 15_000);

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

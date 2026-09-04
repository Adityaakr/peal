/** Metered calls: the x402 handshake, explained and then performed. */
import type { DocsPage } from '../../docs';
import { base } from './runner';
import { esc } from '../../util';

/** A wait a person can read. 103408ms is a number; 1m 43s is a duration. */
function readableMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
import { Payer, payAndFetch, type Receipt } from '../../x402';

export const x402Page: DocsPage = {
  title: 'Metered calls with x402',
  lede: 'Charge for a sealed action per call, with no account, no API key and no invoice. The payment is an on chain transaction and the response carries its hash.',
  html: `
    <h2 id="why">Why a sealed action is worth metering</h2>
    <p>An agent that wants to bid, vote, commit or hold a message until a deadline needs two
    things it usually cannot have at the same time: privacy until the deadline, and a way to pay
    for the service without opening an account first. Signing up is the part that does not survive
    contact with an autonomous caller. It needs an email, a card, a dashboard and a human.</p>

    <p><a href="https://www.x402.org" target="_blank" rel="noopener">x402</a> removes that step by
    using the status code HTTP already reserved for it. The server answers
    <code>402 Payment Required</code> and says what it costs. The caller pays. The caller asks
    again, carrying proof. Nothing is stored about who called, because nothing needed to be.</p>

    <p>Peal is a good fit for that shape because a call here is a discrete unit of work with a
    real cost and a real result: one sealed payload, held until a condition, then opened with a
    proof. It is not a subscription to a dashboard, it is a thing that happens once.</p>

    <h2 id="how">How it works here</h2>
    <p>Every endpoint under <code>/v1</code> is mounted a second time under
    <code>/v1/x402</code>. Same handlers, same request, same response. The only difference is that
    the metered twin answers 402 until it is shown a payment.</p>

    <ol class="doc-steps">
      <li><strong>Ask.</strong> Call <code>/v1/x402/rounds</code> with no payment. You get a 402
      whose body names the asset, the amount, the payee and the chain.</li>
      <li><strong>Pay.</strong> Send that ERC-20 transfer on Tempo. Gas there is itself an ERC-20,
      so the payment and its own gas come out of one balance.</li>
      <li><strong>Ask again.</strong> Repeat the request with
      <code>X-PAYMENT: base64({"txHash":"0x…"})</code>.</li>
      <li><strong>Get the work and the receipt.</strong> The response is the ordinary one, plus an
      <code>X-PAYMENT-RESPONSE</code> header carrying the transaction hash and an explorer link.</li>
    </ol>

    <h3>What the server checks</h3>
    <p>Before a paid call runs, the coordinator asks the chain four questions: has this hash been
    redeemed here before, did the transaction succeed, did it move at least the price in the right
    asset to the right payee, and did it land recently. Redemption is the database insert and the
    hash is the primary key, so one transaction buys exactly one call even if two requests race.</p>

    <div class="doc-callout">
      <p><strong>This is not the <code>exact</code> scheme, and it does not claim to be.</strong>
      The x402 <code>exact</code> scheme on EVM has the payer sign an EIP-3009 authorisation which
      a facilitator broadcasts. That needs a funded key on the server, and this coordinator holds
      none. So the scheme is named <code>tempo-transfer</code>: the payer broadcasts, and the
      server verifies against the chain. Same handshake, same settlement, reached from the other
      side. Naming it <code>exact</code> would mislead a client that knows what that word means.</p>
    </div>

    <h2 id="try">Try it</h2>
    <p>This runs for real. The page mints a keypair in this tab, asks Tempo to fund it, which the
    chain does for anyone with no faucet form and no account, pays the price below, and then makes
    the call. The key never leaves the tab and is never written to storage. It costs you nothing
    and it is a real transaction you can open in the explorer.</p>

    <div class="x402-demo" id="x402-demo">
      <div class="x402-demo-head">
        <button type="button" class="api-btn api-run" id="x402-go">pay and open a round</button>
        <span id="x402-price" class="x402-r-note">checking the price…</span>
      </div>
      <ol class="x402-steps" id="x402-steps"></ol>
      <pre class="api-out" id="x402-out" hidden></pre>
    </div>

    <h2 id="code">In your own code</h2>
    <p>The whole client is the 402, the transfer and the retry. Nothing else.</p>
    <pre class="doc-code"><code>// 1. ask, and read the price out of the refusal
let res = await fetch('https://peal.network/v1/x402/rounds', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ opens_in: 3600, tag: 'my-agent' }),
});

if (res.status === 402) {
  const { accepts: [req] } = await res.json();

  // 2. pay it: an ordinary ERC-20 transfer on the chain the 402 named
  const hash = await wallet.writeContract({
    address: req.asset,
    abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
    functionName: 'transfer',
    args: [req.payTo, BigInt(req.maxAmountRequired)],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  // 3. ask again, carrying the proof
  res = await fetch('https://peal.network/v1/x402/rounds', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payment': btoa(JSON.stringify({ txHash: hash })),
    },
    body: JSON.stringify({ opens_in: 3600, tag: 'my-agent' }),
  });
}

const round = await res.json();
const receipt = JSON.parse(atob(res.headers.get('x-payment-response')));
console.log(round.id, receipt.explorer);</code></pre>

    <h3>What a call costs</h3>
    <p>Ask <code>GET /v0/x402</code> and it tells you, without having to trigger a 402 to find
    out. That endpoint is free, because a price list nobody can read is not a price list.</p>

    <h2 id="free">The free API has not moved</h2>
    <p>Everything under <code>/v1</code> is still free, still needs no key and still needs no
    wallet. Metering is a second door on the same rooms, for people who want to charge for what
    they build on this, or who want to see the handshake work before they do. The
    <a href="#/developers/api">API reference</a> has a switch at the top that sends every run
    button through the metered twin, so you can watch the same request take both paths.</p>

    <p>Paid calls are counted on the <a href="#/developers/network">activity dashboard</a>. That
    number is the one thing on that page nobody has to take on trust: each one is a transaction
    on a public chain.</p>`,

  mount: (root) => {
    const steps = root.querySelector<HTMLElement>('#x402-steps');
    const out = root.querySelector<HTMLElement>('#x402-out');
    const go = root.querySelector<HTMLButtonElement>('#x402-go');
    const priceEl = root.querySelector<HTMLElement>('#x402-price');
    if (!steps || !out || !go) return;

    let stopped = false;

    const step = (text: string, state: 'doing' | 'done' | 'failed'): void => {
      // The running step is replaced in place rather than appended, so the list
      // reads as a sequence of things that happened, not a log.
      const last = steps.lastElementChild as HTMLElement | null;
      if (last?.dataset.state === 'doing') {
        last.remove();
      }
      const li = document.createElement('li');
      li.dataset.state = state;
      li.className = `x402-step is-${state}`;
      li.innerHTML = state === 'doing' ? `<span class="x402-spin"></span>${esc(text)}` : esc(text);
      steps.append(li);
    };

    void (async () => {
      try {
        const quote = (await fetch(`${base}/v0/x402`).then((r) => r.json())) as {
          requirements?: { accepts?: { extra?: { priceDisplay?: string } }[] };
        };
        const shown = quote.requirements?.accepts?.[0]?.extra?.priceDisplay;
        if (priceEl && !stopped) {
          priceEl.textContent = shown
            ? `${shown} a call, on testnet, funded for you`
            : 'metered calls are not available on this deployment';
        }
        if (!shown) go.disabled = true;
      } catch {
        if (priceEl) priceEl.textContent = 'could not reach the price list';
      }
    })();

    const payer = new Payer({
      onPhase: (phase, detail) => {
        const said: Record<string, string> = {
          asking: 'asking what a call costs',
          'creating-wallet': 'minting a keypair in this tab',
          funding: `asking Tempo to fund ${detail ? `${detail.slice(0, 12)}…` : 'it'}, no faucet form`,
          paying: `paying ${detail ?? ''}`.trim(),
          confirming: 'waiting for the transaction to land',
          retrying: 'calling again, carrying the receipt',
        };
        step(said[phase] ?? phase, 'doing');
      },
    });

    const showReceipt = (receipt: Receipt): void => {
      const li = document.createElement('li');
      li.className = 'x402-step is-done';
      li.innerHTML = `paid and settled  <a href="${esc(receipt.explorer)}" target="_blank"
        rel="noopener" class="mono">${esc(receipt.transaction.slice(0, 18))}…</a>`;
      steps.append(li);
    };

    const run = async (): Promise<void> => {
      go.disabled = true;
      steps.innerHTML = '';
      out.hidden = true;
      try {
        const { response, receipt, payMs } = await payAndFetch(
          `${base}/v1/x402/rounds`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ opens_in: 3600, tag: 'x402-demo' }),
          },
          payer,
        );
        const body = await response.text();
        const last = steps.lastElementChild as HTMLElement | null;
        if (last?.dataset.state === 'doing') last.remove();
        if (receipt) showReceipt(receipt);
        step(
          response.ok
            ? `the round exists, ${readableMs(payMs)} of the wait was the chain`
            : `the call came back ${response.status}`,
          response.ok ? 'done' : 'failed',
        );
        out.hidden = false;
        out.classList.toggle('is-error', !response.ok);
        try {
          out.textContent = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          out.textContent = body;
        }
      } catch (err) {
        step(err instanceof Error ? err.message : String(err), 'failed');
      } finally {
        go.disabled = false;
      }
    };

    const onClick = (): void => void run();
    go.addEventListener('click', onClick);
    return () => {
      stopped = true;
      go.removeEventListener('click', onClick);
    };
  },
};

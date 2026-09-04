/** Metered calls: the x402 handshake, explained and then performed. */
import type { DocsPage } from '../../docs';
import { base } from './runner';
import { esc } from '../../util';

/** How long ago, for the settlements feed. */
function ago(unix: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** A wait a person can read. 103408ms is a number; 1m 43s is a duration. */
function readableMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
import { Payer, payAndFetch } from '../../x402';
import { Scene, sceneHtml } from './x402-scene';

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

    <h2 id="watch">Watch it happen</h2>
    <p>Three parties and eight messages. The diagram below is wired to the same
    events the payer emits while it is actually paying, so every beam that lights
    corresponds to a request that was really made, and the hash that lands in it is
    one you can open in the explorer.</p>

    ${sceneHtml()}

    <div class="x402-demo" id="x402-demo">
      <div class="x402-demo-head">
        <button type="button" class="api-btn api-run" id="x402-go">pay and open a round</button>
        <span id="x402-price" class="x402-r-note">checking the price…</span>
      </div>
      <pre class="api-out" id="x402-out" hidden></pre>
    </div>
    <p class="field-hint">This runs for real. The page mints a keypair in this tab,
    asks Tempo to fund it, which the chain does for anyone with no faucet form and no
    account, pays the price above, and makes the call. The key never leaves the tab and
    is never written to storage. It costs you nothing.</p>

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

    <h2 id="uses">What people build with this</h2>
    <p>The pattern is worth something wherever the thing being paid for is a discrete
    action with a real cost, and the caller is not a person who will sit through a
    signup form. Five that fit.</p>

    <div class="x402-uses">
      <article>
        <h3>Pay per bid, in a sealed auction</h3>
        <p>A bid costs a fraction of a cent to place. Bidders stay anonymous until the
        close, nobody opens an account, and the seller is not running a payments
        integration for a listing that might get four bids.</p>
        <p class="x402-use-why"><strong>Why 402:</strong> a bidder who has to register
        is a bidder you lost. The whole point of a sealed auction is that it is cheap
        to enter and impossible to peek at.</p>
      </article>

      <article>
        <h3>Anti-spam that does not need identity</h3>
        <p>Charging for a slot in a round makes flooding it expensive without a
        captcha, an account or a rate limit keyed to an address. A thousand junk
        submissions costs a thousand payments.</p>
        <p class="x402-use-why"><strong>Why 402:</strong> every other anti-spam
        measure works by recognising who you are. This one works without knowing.</p>
      </article>

      <article>
        <h3>Agents committing to each other</h3>
        <p>Two autonomous parties agree a price or an action, seal it until a
        deadline, and settle the fee in the same step. Neither holds an account with
        the other, and neither can see the other's number before the reveal.</p>
        <p class="x402-use-why"><strong>Why 402:</strong> an agent cannot complete a
        signup flow. It can sign a transaction.</p>
      </article>

      <article>
        <h3>Paid disclosure on a timer</h3>
        <p>A report, a price, a model output: sealed now, opened at a stated moment,
        with the fee collected when it is sealed rather than invoiced later. The
        buyer can verify the reveal happened on time and was not edited.</p>
        <p class="x402-use-why"><strong>Why 402:</strong> the payment and the
        commitment are one call, so there is no window where one exists without the
        other.</p>
      </article>

      <article>
        <h3>Metering your own API, on this pattern</h3>
        <p>The most common use, and it does not involve paying us. The gateway here
        is a working reference: refuse with a price, verify the transfer, redeem the
        hash once, then serve. Roughly three hundred lines.</p>
        <p class="x402-use-why"><strong>Why 402:</strong> no keys to issue, no
        invoices to chase, no subscription for somebody who wanted one call.</p>
      </article>
    </div>

    <h2 id="settled">What has settled here</h2>
    <p>Every payment this gateway has accepted, newest first. Each one is a transaction
    on a public chain, so this is the one number on the site that nobody has to take on
    trust.</p>
    <div id="x402-recent" class="x402-recent"><p class="muted">loading…</p></div>

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
    const out = root.querySelector<HTMLElement>('#x402-out');
    const go = root.querySelector<HTMLButtonElement>('#x402-go');
    const priceEl = root.querySelector<HTMLElement>('#x402-price');
    const sceneRoot = root.querySelector<HTMLElement>('#x3');
    if (!out || !go || !sceneRoot) return;

    const scene = new Scene(sceneRoot);
    scene.startIdle();
    let stopped = false;

    // ---- the price, and what has already settled --------------------------
    const loadPrice = async (): Promise<void> => {
      try {
        const quote = (await fetch(`${base}/v0/x402`).then((r) => r.json())) as {
          requirements?: { accepts?: { extra?: { priceDisplay?: string }; payTo?: string }[] };
          recent?: { transaction: string; amount: string; at: number }[];
          paymentsRedeemed?: number;
        };
        const req = quote.requirements?.accepts?.[0];
        const shown = req?.extra?.priceDisplay;
        if (priceEl && !stopped) {
          priceEl.textContent = shown
            ? `${shown} a call, on testnet, funded for you`
            : 'metered calls are not available on this deployment';
        }
        if (!shown) go.disabled = true;

        const feed = root.querySelector<HTMLElement>('#x402-recent');
        if (feed) {
          const rows = quote.recent ?? [];
          feed.innerHTML = rows.length
            ? `<ul class="x402-feed">${rows
                .map(
                  (r) => `<li>
                    <a class="mono" target="_blank" rel="noopener"
                       href="https://explore.testnet.tempo.xyz/tx/${esc(r.transaction)}"
                    >${esc(r.transaction.slice(0, 18))}…${esc(r.transaction.slice(-6))}</a>
                    <span class="x402-feed-when">${esc(ago(r.at))}</span>
                  </li>`,
                )
                .join('')}</ul>
              <p class="field-hint">${quote.paymentsRedeemed ?? rows.length} payment${
                (quote.paymentsRedeemed ?? rows.length) === 1 ? '' : 's'
              } accepted in total.</p>`
            : '<p class="muted">nothing has been paid for yet. the button above would be the first.</p>';
        }
      } catch {
        if (priceEl) priceEl.textContent = 'could not reach the price list';
        const feed = root.querySelector<HTMLElement>('#x402-recent');
        if (feed && feed.textContent?.trim() === 'loading…') {
          feed.innerHTML = '<p class="muted">not reachable from here right now.</p>';
        }
      }
    };
    void loadPrice();

    // ---- the payer drives the diagram -------------------------------------
    //
    // Mapped rather than passed through: the payer reports what it is doing in
    // its own vocabulary, and the diagram names the protocol's steps. Keeping
    // the two apart means neither has to know the other's shape.
    const payer = new Payer({
      onPhase: (phase, detail) => {
        switch (phase) {
          case 'asking':
            scene.enter('ask');
            break;
          case 'creating-wallet':
            scene.enter('quote', 'minting a keypair in this tab');
            break;
          case 'funding':
            scene.enter('fund', detail ? `${detail.slice(0, 14)}…` : undefined);
            break;
          case 'paying':
            scene.enter('pay', detail);
            break;
          case 'confirming':
            scene.enter('confirm', detail ? `${detail.slice(0, 20)}…` : undefined);
            break;
          case 'retrying':
            scene.enter('retry');
            break;
        }
      },
    });

    const run = async (): Promise<void> => {
      go.disabled = true;
      go.textContent = 'paying…';
      scene.reset();
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

        if (receipt) {
          scene.enter('verify', 'receipt checked against the chain');
          scene.enter('serve', `${response.status}, ${readableMs(payMs)} of it on chain`);
        }
        if (response.ok) scene.finish();
        else scene.fail();

        out.hidden = false;
        out.classList.toggle('is-error', !response.ok);
        try {
          out.textContent = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          out.textContent = body;
        }
        if (receipt) {
          out.textContent = `${out.textContent}\n\nsettled: ${receipt.explorer}`;
        }
        void loadPrice();
      } catch (err) {
        scene.fail();
        out.hidden = false;
        out.classList.add('is-error');
        out.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        go.disabled = false;
        go.textContent = 'pay and open a round';
      }
    };

    const onClick = (): void => void run();
    go.addEventListener('click', onClick);
    return () => {
      stopped = true;
      scene.stopIdle();
      go.removeEventListener('click', onClick);
    };
  },
};

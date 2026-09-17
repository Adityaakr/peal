/** Peal Private Links for developers: what it is, how a payment moves, who sees what. */
import type { DocsPage } from '../../docs';
import { esc } from '../../util';
import { shown } from './runner';

export const privateLinks: DocsPage = {
  title: 'Peal Private Links',
  lede: 'A payment request is a link. The payer needs a wallet and nothing else. Between deposit and withdrawal, the amount and the two parties are on no chain.',
  html: `
    <h2 id="what-it-is">What it is</h2>
    <p>Peal Private Links is a private payment ledger with a product on top. You create a request
    (an amount in one asset, a title, an optional reference and expiry), share the link or its QR
    code, and receive the payment into a private balance. The payer opens the link, connects a
    wallet, and pays. Deposits and withdrawals are public transactions through a gateway contract;
    every payment in between is a zero-knowledge proof on a small ledger built for payments.</p>

    <p>The ledger is Commonware's <strong>Bonsai</strong> construction with the
    <strong>ZK-Pari</strong> proof system. Each account is one 32-byte commitment. A payment
    changes two commitments and appends one receipt, proven by a 128-byte proof made in the
    payer's browser in a few seconds. The ledger checks the proof and learns which account acted.
    It does not learn the amount, the other party, or whether it was a send or a receive.</p>

    <p>Today it runs on <strong>Ethereum Sepolia</strong> with Circle's testnet USDC and a faucet
    token, behind a single hosted node. That is a testnet and this is a preview: the section at the
    end says exactly what you are trusting.</p>

    <h2 id="pieces">The pieces</h2>
    <p>Four parts, and the line between them is the privacy boundary. Everything that could
    identify a payment stays in the box on the left.</p>

    <figure class="dev-figure">
      <svg viewBox="0 0 920 372" role="img" class="sketch"
           aria-label="Your app holds the spending key and makes the proofs. The Peal Links node keeps requests, the directory, encrypted receipts and backups, and signs withdrawal certificates. The private ledger holds one commitment per account and a log of receipts. The gateway contract on the chain takes deposits and pays withdrawals.">
        <defs>
          <marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0.5 1 L9 5 L0.5 9" fill="none" stroke="currentColor"
                  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </marker>
        </defs>

        <!-- 1. your app -->
        <g class="sk-node">
          <path class="sk-box sk-box-you"
                d="M18 66 q -2 -12 10 -13 l 236 -2 q 12 0 12.5 11 l 1 96 q 0 12 -11 12.5 l -237 1.5 q -12 0 -12.5 -11 z" />
          <text class="sk-title" x="42" y="86">your app, with a wallet</text>
          <text class="sk-line" x="42" y="110">spending key, balance, receipts</text>
          <text class="sk-strong" x="42" y="132">proofs are made here</text>
          <text class="sk-line" x="42" y="154">nothing that can spend leaves</text>
        </g>

        <!-- 2. node -->
        <g class="sk-node">
          <path class="sk-box"
                d="M348 66 q -2 -12 10 -13 l 218 -2 q 12 0 12.5 11 l 1 96 q 0 12 -11 12.5 l -219 1.5 q -12 0 -12.5 -11 z" />
          <text class="sk-title" x="372" y="86">Peal Links node</text>
          <text class="sk-line" x="372" y="110">requests and the directory</text>
          <text class="sk-line" x="372" y="132">encrypted inbox and backups</text>
          <text class="sk-line" x="372" y="154">chain watcher, withdrawal signers</text>
        </g>

        <!-- 3. ledger -->
        <g class="sk-node">
          <path class="sk-box"
                d="M700 66 q -2 -12 10 -13 l 190 -2 q 12 0 12.5 11 l 1 96 q 0 12 -11 12.5 l -191 1.5 q -12 0 -12.5 -11 z" />
          <text class="sk-title" x="724" y="86">private ledger</text>
          <text class="sk-line" x="724" y="110">one commitment per account</text>
          <text class="sk-line" x="724" y="132">a log of sealed receipts</text>
          <text class="sk-strong" x="724" y="154">sees who acted, nothing else</text>
        </g>

        <!-- 4. chain -->
        <g class="sk-node">
          <path class="sk-box"
                d="M18 268 q -2 -12 10 -13 l 236 -2 q 12 0 12.5 11 l 1 76 q 0 12 -11 12.5 l -237 1.5 q -12 0 -12.5 -11 z" />
          <text class="sk-title" x="42" y="288">gateway contract, Sepolia</text>
          <text class="sk-line" x="42" y="312">deposit(token, amount, tag)</text>
          <text class="sk-line" x="42" y="334">withdraw(message, signatures)</text>
        </g>

        <!-- app -> node: metadata -->
        <path class="sk-arrow" marker-end="url(#pl-arrow)" d="M278 110 L344 110" />
        <text class="sk-tag" x="284" y="100">metadata</text>

        <!-- app -> ledger: proof and envelope, routed above the row -->
        <path class="sk-arrow" marker-end="url(#pl-arrow)" d="M200 53 Q200 24 240 24 L760 24 Q800 24 800 53" />
        <text class="sk-tag" x="436" y="18">proof + sealed receipt</text>

        <!-- app -> gateway: the public legs -->
        <path class="sk-arrow" marker-end="url(#pl-arrow)" d="M100 176 L100 254" />
        <text class="sk-tag" x="112" y="220">public legs</text>

        <!-- gateway -> node: deposit events -->
        <path class="sk-arrow" marker-end="url(#pl-arrow)" d="M278 300 C 380 300, 456 280, 456 178" />
        <text class="sk-tag" x="296" y="322">deposit events</text>
      </svg>
      <figcaption>The node is a service. It can delay or refuse, and it keeps metadata, but it never holds a key that
      opens a balance or a receipt.</figcaption>
    </figure>

    <h2 id="flow">How a payment moves</h2>
    <p>Eight steps. The wallet signs a message in two of them and sends an ordinary transaction
    in two more; the session with the node is a separate sign-in message, once every twelve
    hours.</p>

    <ol class="doc-steps">
      <li><strong>Register.</strong> The receiver's wallet signs in, then signs one EIP-712
      authorization, <code>PealLinksAccount</code>, that binds their address to a fresh private
      account and a receiving key (and, for a wallet that signs deterministically, a recovery
      message that derives the backup key; the SDK's <code>setup</code> batches these). The node
      publishes the profile in the directory, so anyone can pay a plain <code>0x</code> address.
      The spending key is random and never derived from any of those signatures.</li>
      <li><strong>Request.</strong> The receiver's private account signs a manifest (amount, title,
      reference, expiry) and posts it with <code>POST /links/v1/requests</code>. The response is a
      link, <code>${esc(shown)}/pay/&lt;id&gt;</code>. No wallet popup.</li>
      <li><strong>Open.</strong> The payer's client fetches the request and verifies two
      signatures itself: the manifest against the receiver's account, and the receiver's directory
      profile against the wallet address in it. It does not take the node's word for either.</li>
      <li><strong>Fund, if needed.</strong> A deposit is public: the payer proves a deposit
      relation locally, registers the intent with the node, then calls
      <code>gateway.deposit(token, amount, tag)</code> from their wallet. After two confirmations the
      node credits the tag; the wallet claims it with a proof.</li>
      <li><strong>Approve.</strong> The wallet signs a <code>PealLinksPaymentIntent</code> naming
      the amount and the recipient's profile hash. That signature is checked in the payer's own
      client and never transmitted: it is the user saying yes, not a message to a server.</li>
      <li><strong>Prove and send.</strong> The client proves the payment (about seven seconds in a
      browser), submits proof and new commitment with <code>POST /links/v1/ledger/{ns}/ops</code>,
      and drops an encrypted receipt into the receiver's inbox.</li>
      <li><strong>Claim.</strong> Whenever the receiver is next online, they decrypt the receipt,
      check its Merkle path against the ledger, and claim it with a proof. Their balance grows.
      The receipt's position in the log plays the part of a nullifier inside the account's own
      claimed set; unlike a public nullifier set it is never published, since only the account's
      owner can produce a valid claim proof for it.</li>
      <li><strong>Withdraw.</strong> A withdrawal is a send to a fixed burn account, proven like
      any other, followed by a certificate from the node's settlement signers. Anyone can submit
      <code>gateway.withdraw(message, signatures)</code>; the tokens go to the recipient inside
      the signed message.</li>
    </ol>

    <h3>Operation hiding</h3>
    <p>Every operation publishes a record of the same shape and appends exactly one receipt. A
    receive appends an unspendable dummy so it looks like a send. An observer of the ledger sees the
    acting account and a sequence number. That is the entire public record of a private payment.</p>

    <h2 id="who-sees-what">Who sees what</h2>
    <div class="tcard">
      <table>
        <thead><tr><th>who</th><th>sees</th><th>does not see</th></tr></thead>
        <tbody>
          <tr><td>the public ledger</td><td>which account acted, and when</td><td>the amount, the other party, send or receive</td></tr>
          <tr><td>the backing chain</td><td>deposits and withdrawals: address, amount, token</td><td>which private account a deposit went to, any payment in between</td></tr>
          <tr><td>the payer</td><td>the amount, the receiver's display name and wallet address</td><td>the receiver's balance or other payments</td></tr>
          <tr><td>the receiver</td><td>the amount and, for a direct send, who paid</td><td>the payer's balance or history</td></tr>
          <tr><td>the node's directory</td><td>which wallet owns which private account</td><td>payments, amounts, balances</td></tr>
          <tr><td>the node's services</td><td>request titles and amounts you publish, encrypted receipts, timing, IP addresses</td><td>receipt contents, spending keys, balances, payment intents</td></tr>
        </tbody>
      </table>
    </div>
    <p class="dev-note">The node learns the link between a wallet and a private account. It does
    not make them unlinkable, and the docs never say it does. Correlation by amount and timing
    across a deposit and a withdrawal remains possible to an observer of the chain.</p>

    <h2 id="identity">One wallet is the whole identity</h2>
    <ul class="doc-list">
      <li><strong>Receiving profile.</strong> A signed, versioned record in the directory maps a
      wallet address to a private account and a receiving key. A rename or a revocation is a new
      version that names the previous one's hash, so a client that has seen version n refuses an
      older one.</li>
      <li><strong>Recovery.</strong> A wallet that signs deterministically derives a backup key from
      one signature over a fixed message; the rest get a recovery code shown once. The node keeps an
      encrypted, versioned backup only that key opens. Losing both the device and the recovery
      material loses the account, and nobody can help.</li>
      <li><strong>Several wallets, one device.</strong> Each wallet gets its own store. Several tabs
      of one browser share an account through a lock and a versioned blob, so a stale tab cannot
      submit against an old commitment.</li>
    </ul>

    <h2 id="code">In your own code</h2>
    <p>The TypeScript SDK does all of the above. Here is the shape of it, adapted from the SDK's
    own tests; the <a href="#/developers/links-sdk">SDK reference</a> has every method.</p>
    <pre class="doc-code"><code>import { LinksAccount, NodeClient, loadParams, newIntentId,
         paymentIntentTypedData, siweMessage } from 'peal-links';
import { createLocalProver } from 'peal-links/local';

// 1. one node, one namespace (an asset on a chain), one prover
const client = new NodeClient({ baseUrl: '${esc(shown)}' });
const status = await client.status();
const ns = status.namespaces.find((n) => n.label === 'sepolia/USDC')!;
const prover = await createLocalProver();          // in a page: createRemoteProver(worker)
await loadParams(client, prover, store);            // proving keys, verified by digest

// 2. a session: the wallet signs a sign-in message (requests, profile and backups need one)
const { nonce } = await client.nonce();
const message = siweMessage({ domain: 'peal.network', address: signer.address,
                              uri: '${esc(shown)}', chainId: ns.chain_id, nonce });
await client.session(message, await signer.signMessage(message));

// 3. the receiver: one wallet signature for the profile, then a request with no popup
const bob = await LinksAccount.setup(
  { prover, client, namespace: ns.id, store }, status.circuit_id, signer, 'Bob', recovery);
const request = await bob.createRequest({ amount: '12500000', title: 'Logo files' });
// share: ${esc(shown)}/pay/ + request.manifest.request_id

// 4. the payer: fetch the request, let the wallet approve, prove, send
const fetched = await client.getRequest(request.manifest.request_id);
const intent = await alice.paymentIntentFor({ request: fetched });
const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
await alice.pay({ request: fetched }, newIntentId(), { intent, signature });

// 5. the receiver, whenever next online
await bob.sync();       // deposits, inbox, receipt paths, undelivered envelopes
await bob.claimAll();   // one proof per receipt; balance grows</code></pre>
    <p>Two things the SDK is careful about. Amounts are strings of integer base units on every
    boundary (12500000 is 12.50 USDC), never floats. And nothing that could spend leaves the
    client: the node receives proofs, commitments and ciphertext, and the wallet's approval
    signature is checked locally and thrown away.</p>
    <p class="dev-note">The sign-in in step 2 names a domain the node accepts, and the hosted node
    accepts <code>peal.network</code>. An app on its own origin runs its own node with its domain
    in <code>PEAL_LINKS_AUTH_DOMAINS</code>; the <a href="#/developers/links-api#auth">API
    reference</a> says why.</p>

    <h2 id="deployed">What is deployed</h2>
    <ul class="doc-list">
      <li><strong>Ethereum Sepolia</strong> (chain 11155111): USDC (Circle's testnet issue) and
      tUSD (a faucet token), both 6 decimals, two confirmations. Gateway
      <code>0xC141Bc6AaED24258276dC203050AD148ec95C1fC</code>. Live behind this site, and the
      app at <a href="#/bonsai/app">${esc(shown)}/#/bonsai/app</a>.</li>
      <li><strong>Tempo Moderato</strong> (chain 42431): PathUSD and tUSD. Gateway
      <code>0xE747A08e7cFea2574bCc9A0a8FCb6E02a68D6F39</code>. Run on demand from the
      repository, not hosted.</li>
    </ul>
    <p>Everything a client needs to configure itself is in one call:
    <code>GET ${esc(shown)}/links/v1/status</code> lists the namespaces (chain, token, decimals,
    gateway, confirmations), the circuit id and the settlement signers. The
    <a href="#/developers/links-api">API reference</a> runs it from the page.</p>

    <h2 id="trust">What you are trusting, stated plainly</h2>
    <div class="doc-callout">
      <p><strong>This is a testnet preview with real cryptography and an unfinished trust
      model.</strong> Withdrawals are released by a certificate from settlement signers, two of
      three, whose keys currently live in one process run by the operator. A compromised threshold
      can release reserves; if the operator disappears, funds not yet withdrawn are stuck. The
      proving keys come from a per-process setup, not a ceremony. The upstream circuits are a
      pinned prototype revision with no external review. The ledger is one hosted node, not a
      validator set. These gaps are about custody and soundness, not a known flaw in the privacy
      argument; but the circuits and Peal's integration of them are unreviewed, so treat that
      argument as unaudited too. All of it is why the node refuses to run its settlement signers or
      the dev-mint fixture beside a mainnet namespace, so no mainnet withdrawal is possible
      today.</p>
    </div>
    <p>The list of what changes before real money is in the repository's
    <a href="https://github.com/Adityaakr/peal-network/blob/main/docs/peal-links/MAINNET_READINESS.md" target="_blank" rel="noopener">mainnet readiness</a>
    document, and the full observer matrix and threats in the
    <a href="https://github.com/Adityaakr/peal-network/blob/main/docs/peal-links/THREAT_MODEL.md" target="_blank" rel="noopener">threat model</a>.
    Do not call the bridge trustless, and do not call the payments unlinkable. They are private,
    which is a different and true claim.</p>

    <h2 id="next">Where to go next</h2>
    <ul class="doc-list">
      <li><a href="#/developers/links-sdk">Private Links SDK</a>: install, the account object,
      every method, and running it from Node.</li>
      <li><a href="#/developers/links-api">Private Links API</a>: every endpoint under
      <code>/links/v1</code>, the encodings, the error format and the limits.</li>
      <li><a href="#/developers/agents">Use it from an agent</a>: the skill carries a reference
      file for this, so an agent can integrate it without reading these pages.</li>
      <li><a href="#/bonsai">The product page</a> shows the checkout and the dashboard this is
      built into.</li>
    </ul>`,
};

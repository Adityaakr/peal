/** The peal-links TypeScript SDK: install, the account object, every method, Node.js. */
import type { DocsPage } from '../../docs';
import { esc } from '../../util';
import { shown } from './runner';

export const privateLinksSdk: DocsPage = {
  title: 'Private Links SDK',
  lede: 'A typed TypeScript client for the private ledger, requests, inbox, backups and the chain legs. The proofs run in wasm, in a page, a worker or Node.',
  html: `
    <h2 id="install">Install</h2>
    <p>The package is <code>peal-links</code> in the
    <a href="https://github.com/Adityaakr/peal-network/tree/main/packages/links" target="_blank" rel="noopener">repository</a>.
    It is not on npm yet: it ships as source (<code>main</code> points at
    <code>src/index.ts</code>) with the wasm prover inlined as base64, so there is no build step
    and no bundler configuration. Use it as a workspace or path dependency, and bring
    <code>viem</code>, which it uses for typed data, addresses and the gateway calls.</p>
    <pre class="doc-code"><code># from your project's directory
git clone https://github.com/Adityaakr/peal-network ../peal-network
pnpm add ../peal-network/packages/links viem</code></pre>
    <p>Three entry points, kept apart so a page that proves in a worker does not bundle the wasm
    twice:</p>
    <div class="tcard">
      <table>
        <thead><tr><th>import</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>peal-links</code></td><td>the client, the account, stores, signers, chain helpers, <code>loadParams</code>, <code>newIntentId</code></td></tr>
          <tr><td><code>peal-links/local</code></td><td><code>createLocalProver()</code>: the prover in the current thread. Node, tests, scripts.</td></tr>
          <tr><td><code>peal-links/worker</code></td><td><code>serveProver(self)</code> inside a Web Worker; the page uses <code>createRemoteProver(worker)</code>. A proof takes seconds and would freeze a page.</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="bootstrap">Bootstrap</h2>
    <p>Everything a client needs to configure itself comes from the node. One status call names
    the namespaces (an asset on a chain), the circuit id and the signers; the params call serves
    the proving keys by digest.</p>
    <pre class="doc-code"><code>import { NodeClient, loadParams, indexedDbStore } from 'peal-links';
import { createLocalProver } from 'peal-links/local';

const client = new NodeClient({ baseUrl: '${esc(shown)}' });   // '' when served from the same origin
const status = await client.status();
const ns = status.namespaces.find((n) => n.label === 'sepolia/USDC')!;

const store = indexedDbStore();                 // browser; new MemoryStore() or your own in Node
const prover = await createLocalProver();
await loadParams(client, prover, store);        // ~15 MB proving key, verified by SHA-256, cached in the store</code></pre>
    <p><code>loadParams</code> downloads <code>op.pk</code>, <code>op.vk</code>,
    <code>deposit.pk</code> and <code>deposit.vk</code>, checks each digest against the index,
    and refuses to prove if the node's circuit id does not match the keys.</p>

    <h2 id="signer">The wallet signer</h2>
    <p>The SDK never holds a wallet key. It asks a <code>WalletSigner</code> to sign: at setup, a
    sign-in message, the recovery message (twice, if the wallet signs deterministically) and the
    profile; every twelve hours, a sign-in; per payment, one approval. Deposits and withdrawals
    are ordinary transactions the wallet sends.</p>
    <pre class="doc-code"><code>interface WalletSigner {
  address: string;
  chainId: number;
  signTypedData(typed): Promise&lt;Hex&gt;;   // EIP-712
  signMessage(message): Promise&lt;Hex&gt;;   // EIP-191
}

providerSigner(provider, address, chainId)  // a browser wallet (EIP-1193)
localSigner(privateKeyToAccount(key), chainId)  // viem, for Node and tests</code></pre>
    <div class="tcard">
      <table>
        <thead><tr><th>what the wallet signs</th><th>kind</th><th>when</th><th>goes to</th></tr></thead>
        <tbody>
          <tr><td>a sign-in message (EIP-4361)</td><td>message</td><td>once per session, 12 hours</td><td>the node, for a bearer token</td></tr>
          <tr><td><code>PealLinksAccount</code>: wallet, private account, receiving key, display name</td><td>typed data</td><td>setup, rename, revoke</td><td>the node's directory, in clear</td></tr>
          <tr><td>a fixed recovery message</td><td>message, signed twice</td><td>setup and recovery, if the wallet signs deterministically</td><td>nowhere; derives the backup key in memory</td></tr>
          <tr><td><code>PealLinksPaymentIntent</code>: amount, recipient profile hash, request id</td><td>typed data</td><td>each payment</td><td>nowhere; verified in the client and discarded</td></tr>
        </tbody>
      </table>
    </div>
    <p class="dev-note">The EIP-712 domain is <code>{ name: 'Peal Links', version: '1', chainId }</code>
    with no verifying contract. The node can verify an ERC-1271 profile signature, but publishing
    needs a session and sessions are for externally owned accounts only, so a contract wallet
    cannot use this today.</p>

    <h3>Sessions</h3>
    <p>Requests, the profile and backups need a session with the node; the ledger, the inbox and
    settlement do not. A session is a bearer token from one sign-in message, kept on the client
    for twelve hours. Nothing renews it silently: when it lapses, the next call that needs one
    fails with a <code>LinksApiError</code> of status 401, and the app asks the wallet to sign in
    again. <code>unlock</code> needs no signature because it only opens the local wallet.</p>
    <pre class="doc-code"><code>const { nonce } = await client.nonce();
const message = siweMessage({ domain: 'peal.network', address: signer.address,
                              uri: '${esc(shown)}', chainId: ns.chain_id, nonce });
await client.session(message, await signer.signMessage(message));   // stores the token on the client
const { address, expires_at } = await client.me();</code></pre>

    <h2 id="account">The account</h2>
    <p><code>LinksAccount</code> is one private account on one namespace. It is created once,
    unlocked on the same device, or recovered on a new one.</p>
    <pre class="doc-code"><code>import { LinksAccount, deriveBackupKey, deterministicSignature,
         recoveryMessage, newRecoveryCode, siweMessage } from 'peal-links';

const opts = { prover, client, namespace: ns.id, store };   // + deviceKeys, publicClient (optional)

// a session first: setup publishes the profile, and the directory needs one
const { nonce } = await client.nonce();
const message = siweMessage({ domain: 'peal.network', address: signer.address,
                              uri: '${esc(shown)}', chainId: ns.chain_id, nonce });
await client.session(message, await signer.signMessage(message));

// recovery: from a deterministic wallet signature when the wallet gives one, else a code shown once
const sig = await deterministicSignature(signer, recoveryMessage(signer.address, ns.label, ns.id));
const recovery = sig
  ? { mechanism: 'wallet-signature', backupKey: await deriveBackupKey(sig, signer.address, ns.id) }
  : { mechanism: 'recovery-code', code: newRecoveryCode() };   // show the code to the user once

const account = await LinksAccount.setup(opts, status.circuit_id, signer, 'Alice', recovery);
const again = await LinksAccount.unlock(opts);              // same device, no signature
const moved = await LinksAccount.recover(opts, recovery);   // new device, from the node's backup</code></pre>
    <p><code>setup</code> registers the account on the ledger, has the wallet sign the profile,
    publishes it, seals the wallet under a device key and uploads the first backup. It throws if
    the backup fails, because an account nobody can recover should not exist.</p>

    <h3>Every method</h3>
    <div class="tcard">
      <table>
        <thead><tr><th>method</th><th>does</th></tr></thead>
        <tbody>
          <tr><td><code>LinksAccount.exists(store, ns)</code></td><td>whether an encrypted wallet is in the store</td></tr>
          <tr><td><code>LinksAccount.setup(opts, circuitId, signer, name, recovery)</code></td><td>create, register, publish the profile, back up</td></tr>
          <tr><td><code>LinksAccount.unlock(opts)</code></td><td>returning visit on the same device</td></tr>
          <tr><td><code>LinksAccount.recover(opts, recovery)</code></td><td>new device: fetch the backup, open it, reconcile, adopt the profile</td></tr>
          <tr><td><code>LinksAccount.restoreFile(opts, json, code)</code></td><td>restore from an exported backup file</td></tr>
          <tr><td><code>view()</code></td><td><code>balance</code>, <code>unclaimed</code>, <code>pending</code>, <code>receipts</code>, <code>history</code>, all amounts as strings</td></tr>
          <tr><td><code>createRequest({ amount, title, reference?, expiresAt? })</code></td><td>a signed payment link; no wallet popup; needs a profile</td></tr>
          <tr><td><code>resolve(address)</code></td><td>directory lookup with full verification: address, namespace, expiry, revocation, signature, hash chain</td></tr>
          <tr><td><code>paymentIntentFor(target)</code></td><td>the typed data to hand to the wallet</td></tr>
          <tr><td><code>pay(target, intentId, approval?)</code></td><td>verify the target, reserve the request, prove the send, submit, deliver the receipt</td></tr>
          <tr><td><code>sync()</code></td><td>one pass: reconcile, deposits, inbox, receipt paths, undelivered envelopes; returns <code>{ credited, discovered, stale }</code></td></tr>
          <tr><td><code>syncInbox()</code>, <code>verifyReceipts()</code></td><td>the two halves of receiving, if you want them apart</td></tr>
          <tr><td><code>claim(index)</code>, <code>claimAll()</code></td><td>one proof per receipt; the balance grows</td></tr>
          <tr><td><code>acknowledge(requestId, position)</code></td><td>mark a request fulfilled, signed by the receiver's account</td></tr>
          <tr><td><code>prepareDeposit(amount, reference?)</code></td><td>prove the deposit relation, register the intent, return the 32-byte tag for the chain</td></tr>
          <tr><td><code>syncDeposits()</code></td><td>poll pending deposits; credit the ones the watcher has seen</td></tr>
          <tr><td><code>withdraw(amount, recipient)</code></td><td>prove the burn, submit, obtain the certificate</td></tr>
          <tr><td><code>settle(position)</code></td><td>fetch the certificate for a burn again, idempotently</td></tr>
          <tr><td><code>publishProfile(signer, name, recovery, revoked?)</code></td><td>the next profile version: this is rename, and revocation</td></tr>
          <tr><td><code>profile()</code>, <code>walletAddress()</code>, <code>hasRecovery()</code></td><td>what this account knows about itself</td></tr>
          <tr><td><code>backupNow()</code>, <code>exportBackup(code)</code></td><td>upload the sealed state; write a file under a recovery code</td></tr>
          <tr><td><code>refreshFromStore()</code>, <code>refreshFromBackup()</code></td><td>pick up a newer blob another tab or device saved</td></tr>
          <tr><td><code>reconcile()</code></td><td>resolve a pending operation against the ledger: <code>in_sync</code>, <code>committed</code>, <code>aborted</code> or <code>conflict</code></td></tr>
          <tr><td><code>flushOutbox()</code></td><td>retry receipts that were not delivered</td></tr>
          <tr><td><code>label(position, address)</code>, <code>labels()</code></td><td>device-local names for the sends you made</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="pay">A payment, end to end</h2>
    <p>The receiver makes a request; the payer funds, approves, and pays; the receiver claims.
    Adapted from the SDK's test suite, which drives the gateway with viem directly where this
    uses the chain helpers.</p>
    <pre class="doc-code"><code>// receiver
const request = await bob.createRequest({ amount: '12500000', title: 'Logo files', reference: 'INV-7' });
const link = '${esc(shown)}/pay/' + request.manifest.request_id;

// payer: fund the private balance (public, once)
const unit = 10n ** BigInt(ns.decimals);
const { receipt } = await alice.prepareDeposit((100n * unit).toString());
await depositOnChain(ns, provider, signer.address, 100n * unit, receipt);   // approve + gateway.deposit
while ((await alice.syncDeposits()).length === 0) await sleep(1000);      // 2 confirmations
await alice.claimAll();

// payer: pay the request
const fetched = await client.getRequest(request.manifest.request_id);
const intent = await alice.paymentIntentFor({ request: fetched });
const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
const { position, delivered } = await alice.pay({ request: fetched }, newIntentId(), { intent, signature });

// payer: or pay an address directly
const r = await alice.resolve('0x…');
await alice.pay({ profile: r.profile, profileHash: r.hash, amount: '2000000', reference: 'tip' }, newIntentId(), approval);

// receiver
const { discovered } = await bob.sync();
await bob.claimAll();
await bob.acknowledge(request.manifest.request_id, position);   // optional: marks the link fulfilled

// receiver: leave
const { certificate } = await bob.withdraw('4000000', '0xRecipient');
await withdrawOnChain(ns, provider, signer.address, certificate);   // anyone may submit it</code></pre>
    <p><code>pay</code> refuses a request from another namespace, one that does not verify, one
    that is not active or has expired, and any amount above the balance. With an approval it also
    checks that the intent names this exact target and that the signature recovers to the wallet
    in the profile. The request path takes a ten minute soft reservation first, so two
    well-behaved payers do not race. It is a courtesy the node keeps, not a rule the ledger
    enforces: two clients that ignore it can both pay, and the receiver gets both receipts.</p>

    <h2 id="money">Money and encodings</h2>
    <ul class="doc-list">
      <li>Amounts are decimal strings of integer base units everywhere: <code>'12500000'</code>
      is 12.50 USDC. Decimals come from the namespace. Compare with <code>BigInt</code>, never
      with floats.</li>
      <li>Namespace ids, account ids, keys and receipt tags are 32 bytes as 64 lowercase hex
      characters without <code>0x</code>. The chain legs add <code>0x</code> where a
      <code>bytes32</code> is needed.</li>
      <li>Wallet addresses are lowercase <code>0x</code> strings in profiles and manifests.
      Timestamps are Unix seconds.</li>
      <li>A payment intent expires ten minutes after it is made; a profile is valid for a
      year and is renewed by publishing the next version.</li>
    </ul>

    <h2 id="node">From Node.js</h2>
    <p>The test suite runs in Node, so a server or a script can hold an account. What changes
    outside a browser:</p>
    <ul class="doc-list">
      <li><strong>Prover.</strong> <code>createLocalProver()</code> from <code>peal-links/local</code>.
      It is single-threaded; a proof blocks for a few seconds.</li>
      <li><strong>Store.</strong> Implement <code>WalletStore</code>: three async methods,
      <code>get</code>, <code>set</code>, <code>delete</code>, string to string. Every value is
      ciphertext or a cursor. <code>MemoryStore</code> is for tests.</li>
      <li><strong>Device keys.</strong> Without <code>deviceKeys</code> the wallet is sealed under an
      in-memory key that dies with the process; persistence then relies on the node backup
      (<code>recover</code>) or an exported file. Pass your own <code>DeviceKeys</code> to keep it.</li>
      <li><strong>Signer.</strong> <code>localSigner(privateKeyToAccount(key), chainId)</code>. A
      viem local account signs deterministically, so the wallet-signature recovery works.</li>
      <li><strong>Chain legs.</strong> <code>depositOnChain</code> and <code>withdrawOnChain</code>
      take an EIP-1193 provider. From Node, call the gateway with viem and the exported
      <code>GATEWAY_ABI</code> and <code>ERC20_ABI</code>, as the tests do.</li>
      <li><strong>Locks.</strong> The SDK uses Web Locks when present so two tabs never submit
      against the same commitment. Node has none; do not run two processes on one account.</li>
      <li><strong>Sessions.</strong> Requests, the directory and backups need a bearer token from
      a sign-in message. The hosted node accepts sign-ins for <code>peal.network</code>; for your
      own origin, run a node with your domain in <code>PEAL_LINKS_AUTH_DOMAINS</code>.</li>
    </ul>

    <h2 id="errors">Errors</h2>
    <p>Every node error is a <code>LinksApiError</code> with <code>status</code> and
    <code>code</code>, the code the API returns in its <code>application/problem+json</code>
    body. A network failure, a body that is not JSON, or a 502, 503 or 504 is status 0 with code
    <code>unreachable</code>, so the API's 503 codes (a signer short, a chain unreachable) are not
    visible through the SDK; retry them. A 500 keeps its status and code. The
    <a href="#/developers/links-api">API reference</a> lists the codes per endpoint.</p>

    <h2 id="next">Where to go next</h2>
    <ul class="doc-list">
      <li><a href="#/developers/links">Peal Private Links</a>: what the pieces are and who sees what.</li>
      <li><a href="#/developers/links-api">Private Links API</a>: the endpoints the SDK calls, for any language.</li>
      <li><a href="https://github.com/Adityaakr/peal-network/blob/main/packages/links/test/e2e.test.ts" target="_blank" rel="noopener">The end to end test</a>: two accounts on a local stack, every step above, run in CI.</li>
    </ul>`,
};

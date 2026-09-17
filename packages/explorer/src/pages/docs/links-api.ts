/** The Peal Links node HTTP API: every route under /links/v1, encodings, errors, limits. */
import type { DocsPage } from '../../docs';
import { esc } from '../../util';
import { base, demoHtml, readJson, shown, wireDemos, type Demo } from './runner';

const linksBase = `${base}/links/v1`;

const demos: Demo[] = [
  {
    id: 'links-status',
    title: 'Read the node',
    note: 'One call configures a client: the namespaces (an asset on a chain), the circuit id the proving keys must match, and the settlement signers. This runs against the live node.',
    code: `const res = await fetch('${shown}/links/v1/status');
const status = await res.json();
for (const ns of status.namespaces) {
  console.log(ns.label, ns.chain_name, ns.token_address, ns.decimals, 'decimals');
}
console.log('circuit', status.circuit_id);
console.log('signers', status.signers.length, 'threshold', status.signer_threshold);`,
    run: async (log) => {
      const res = await fetch(`${linksBase}/status`);
      const status = (await readJson(res, 'GET /links/v1/status')) as {
        circuit_id: string;
        ledger_mode: string;
        signer_mode: string;
        signers: string[];
        signer_threshold: number;
        namespaces: { id: string; label: string; chain_name: string; token_address: string; decimals: number; gateway: string; confirmations: number; available: boolean }[];
      };
      for (const ns of status.namespaces) {
        log(`${ns.label}: ${ns.chain_name}, token ${ns.token_address}, ${ns.decimals} decimals, ${ns.confirmations} confirmations, ${ns.available ? 'available' : 'unavailable'}`);
        log(`  namespace id ${ns.id}`);
        log(`  gateway ${ns.gateway}`);
      }
      log(`circuit ${status.circuit_id}`);
      log(`ledger ${status.ledger_mode}; signers ${status.signers.length} (${status.signer_mode}), threshold ${status.signer_threshold}`);
    },
  },
  {
    id: 'links-ledger',
    title: 'Read the public ledger',
    note: 'The ledger and its accounting are public and need no session. Notice what a record is: an account id, a sequence number, a proof. No amount, no counterparty.',
    code: `const status = await (await fetch('${shown}/links/v1/status')).json();
const ns = status.namespaces[0].id;

const ledger = await (await fetch('${shown}/links/v1/ledger/' + ns)).json();
console.log('seq', ledger.seq, 'receipts', ledger.receipt_count, 'state root', ledger.state_root);

const books = await (await fetch('${shown}/links/v1/ledger/' + ns + '/accounting')).json();
console.log('minted', books.minted_total, 'withdrawn', books.withdrawn_total, 'outstanding', books.outstanding_liability);

const history = await (await fetch('${shown}/links/v1/ledger/' + ns + '/history?limit=3')).json();
for (const op of history.ops) {
  // a register names a pubkey, an op names an account, a mint names a deposit tag
  console.log(op.seq, op.kind, op.envelope.account ?? op.envelope.pubkey ?? op.envelope.intent.receipt);
}`,
    run: async (log) => {
      const status = (await readJson(await fetch(`${linksBase}/status`), 'GET /links/v1/status')) as {
        namespaces: { id: string; label: string }[];
      };
      const first = status.namespaces[0];
      if (!first) throw new Error('the node lists no namespaces');
      log(`namespace ${first.label} (${first.id})`);
      const ledger = (await readJson(await fetch(`${linksBase}/ledger/${first.id}`), 'GET /links/v1/ledger/{ns}')) as {
        seq: number; receipt_count: number; state_root: string; receipt_root: string;
      };
      log(`seq ${ledger.seq}, receipts ${ledger.receipt_count}`);
      log(`state root ${ledger.state_root}`);
      log(`receipt root ${ledger.receipt_root}`);
      const books = (await readJson(await fetch(`${linksBase}/ledger/${first.id}/accounting`), 'GET /links/v1/ledger/{ns}/accounting')) as {
        minted_total: string; withdrawn_total: string; outstanding_liability: string;
      };
      log(`minted ${books.minted_total}, withdrawn ${books.withdrawn_total}, outstanding ${books.outstanding_liability} (base units)`);
      const history = (await readJson(await fetch(`${linksBase}/ledger/${first.id}/history?limit=3`), 'GET /links/v1/ledger/{ns}/history')) as {
        ops: { seq: number; kind: string; position: number | null; envelope: { account?: string; pubkey?: string; deposit_id?: string; intent?: { receipt: string; amount: number } } }[];
      };
      if (history.ops.length === 0) log('no operations yet on this namespace');
      for (const op of history.ops) {
        const at = op.position === null ? '' : `, receipt at ${op.position}`;
        if (op.kind === 'mint') {
          log(`${op.seq} mint: deposit ${op.envelope.deposit_id ?? '?'} credited to tag ${op.envelope.intent?.receipt ?? '?'}${at} (a deposit is public: its amount is ${op.envelope.intent?.amount ?? '?'})`);
        } else if (op.kind === 'register') {
          log(`${op.seq} register: pubkey ${op.envelope.pubkey ?? '?'}`);
        } else {
          log(`${op.seq} op: account ${op.envelope.account ?? '?'}${at} (no amount, no counterparty, no direction)`);
        }
      }
    },
  },
];

export const privateLinksApi: DocsPage = {
  title: 'Private Links API',
  lede: 'Every route the Peal Links node serves under /links/v1, with what authenticates it, what it takes, what it returns and how it fails. This is what the SDK calls; any language can.',
  wide: true,
  html: `
    <h2 id="base">Base URL and conventions</h2>
    <p>The hosted node answers at <code>${esc(shown)}/links/v1</code>, behind the same origin as
    this page. A node you run yourself serves the same paths on its own port. Bodies are JSON,
    responses are JSON, and errors are <code>application/problem+json</code>.</p>
    <ul class="doc-list">
      <li><strong>Amounts</strong> are decimal strings of integer base units:
      <code>"12500000"</code> is 12.50 USDC. One exception is called out below.</li>
      <li><strong>32-byte values</strong> (namespace ids, account ids, keys, tags, roots) are 64
      lowercase hex characters without <code>0x</code>. Field elements are canonical little-endian
      encodings below the BLS12-381 scalar modulus; a value at or above it is rejected as
      <code>malformed</code>.</li>
      <li><strong>Addresses</strong> are lowercase <code>0x</code> strings. <strong>Timestamps</strong>
      are Unix seconds. <strong>Proofs</strong> are exactly 128 bytes, as hex.</li>
      <li><strong>A namespace</strong> is one asset on one chain. Its id is
      <code>SHA-256("peal-links/v1/namespace" || 0x00 || label)</code>, so
      <code>sepolia/USDC</code> always has the same id on every node that serves it.</li>
      <li><strong>An account id</strong> is a field element derived from the namespace and the
      account's ed25519 public key. <strong>A position</strong> is the index of a receipt in the
      namespace's append-only log.</li>
    </ul>

    ${demoHtml(demos[0])}

    <h2 id="auth">Three ways a call is authenticated</h2>
    <div class="tcard">
      <table>
        <thead><tr><th>mechanism</th><th>how</th><th>routes</th></tr></thead>
        <tbody>
          <tr><td><strong>none</strong></td><td>public reads, and writes that carry their own proof</td><td>status, params, ledger, a request by id, reserve, deposit intents, withdrawal status, inbox writes</td></tr>
          <tr><td><strong>session</strong></td><td><code>Authorization: Bearer &lt;token&gt;</code> from a wallet sign-in (EIP-4361 message, EIP-191 signature). 12 hours. Externally owned accounts only.</td><td>requests (create, list, archive), directory, backups, <code>/auth/me</code></td></tr>
          <tr><td><strong>account signature</strong></td><td>an ed25519 signature by the private account's spending key over domain-tagged bytes, inside the body (or, for inbox reads, in the <code>x-peal-inbox-auth</code> header)</td><td>ledger register and ops, fulfill, inbox key binding, inbox reads, withdrawals</td></tr>
        </tbody>
      </table>
    </div>
    <p>A session authorizes product metadata only: requests, a profile, a backup. It confers no
    spending authority. Anything that moves value carries a proof and an account signature. The
    node cannot forge the signature, and cannot forge the proof under the proof system's soundness
    assumption; today's per-process key setup and unreviewed circuits mean that assumption is
    itself unaudited (see <a href="#/developers/links#trust">what you are trusting</a>).</p>
    <div class="doc-callout">
      <p><strong>Sign-in is bound to a domain.</strong> The <code>domain</code> line of the sign-in
      message must be one the node accepts; the hosted node accepts <code>peal.network</code>. A
      third-party app on its own origin should run its own node with its domain in
      <code>PEAL_LINKS_AUTH_DOMAINS</code>, rather than ask a wallet to sign in to a site it is not
      on.</p>
    </div>
    <pre class="doc-code"><code>// 1. a nonce, good for ten minutes
const { nonce } = await (await fetch('${esc(shown)}/links/v1/auth/nonce')).json();

// 2. the wallet signs an EIP-4361 message naming the domain, the address and the nonce
const message = 'peal.network wants you to sign in with your Ethereum account:\\n' + address + '\\n\\n'
  + 'URI: https://peal.network\\nVersion: 1\\nChain ID: ' + ns.chain_id   // the namespace's chain
  + '\\nNonce: ' + nonce + '\\nIssued At: ' + new Date().toISOString();
const signature = await wallet.signMessage(message);

// 3. a bearer token
const res = await fetch('${esc(shown)}/links/v1/auth/session', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, signature }),
});
const { token, expires_at } = await res.json();
// then: headers: { authorization: 'Bearer ' + token }</code></pre>

    <h2 id="node">Node</h2>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>GET /status</code></td><td>none</td><td><code>ok</code>, <code>version</code>, <code>circuit_id</code>, <code>ledger_mode</code>, <code>signers[]</code>, <code>signer_threshold</code>, <code>dev_mint</code>, <code>namespaces[]</code> (<code>id</code>, <code>label</code>, <code>chain_id</code>, <code>chain_name</code>, <code>token_symbol</code>, <code>token_address</code>, <code>decimals</code>, <code>gateway</code>, <code>confirmations</code>, <code>available</code>, <code>environment</code>, <code>explorer_url</code>, <code>rpc_url</code>), <code>ledgers[]</code> (<code>namespace</code>, <code>seq</code>, <code>receipt_count</code>, <code>state_root</code>, <code>receipt_root</code>)</td></tr>
          <tr><td><code>GET /params</code></td><td>none</td><td><code>circuit_id</code>, <code>setup</code>, <code>files</code>: <code>op.pk</code>, <code>op.vk</code>, <code>deposit.pk</code>, <code>deposit.vk</code>, each with <code>digest</code> and <code>size</code></td></tr>
          <tr><td><code>GET /params/{name}</code></td><td>none</td><td>the raw key bytes; <code>ETag</code> is the digest, <code>Cache-Control: immutable</code>, honours <code>If-None-Match</code>. 404 <code>unknown_param</code>.</td></tr>
          <tr><td><code>GET /consensus</code></td><td>none</td><td>the validator view when the node runs under consensus; 404 <code>single_node</code> on the hosted node</td></tr>
          <tr><td><code>GET /healthz</code></td><td>none</td><td>at the root, not under <code>/links/v1</code>: <code>{"ok":true}</code></td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="ledger">Ledger</h2>
    <p>The ledger is what the proofs are about. It is public: a record names the acting account,
    its old and new commitment, one receipt, the root the proof was made against, and the proof.
    It carries no amount and no counterparty. Which account acted, and when, is intentionally
    public, and the directory lets anyone who knows a wallet address link it to that account's
    activity.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>GET /ledger/{ns}</code></td><td>none</td><td><code>seq</code>, <code>receipt_count</code>, <code>state_root</code>, <code>receipt_root</code>, <code>recent_roots[]</code>, <code>minted_total</code></td></tr>
          <tr><td><code>GET /ledger/{ns}/accounts/{acct}</code></td><td>none</td><td><code>account</code>, <code>com</code> (the current commitment), <code>updated_seq</code>. 404 <code>unknown_account</code>.</td></tr>
          <tr><td><code>POST /ledger/{ns}/register</code></td><td>account signature</td><td>body <code>namespace</code>, <code>pubkey</code>, <code>randomness</code>, <code>signature</code>. Returns <code>seq</code>, <code>state_root</code>, <code>receipt_root</code>, <code>position: null</code>. 409 <code>account_exists</code>.</td></tr>
          <tr><td><code>POST /ledger/{ns}/ops</code></td><td>account signature</td><td>body <code>namespace</code>, <code>circuit_id</code>, <code>account</code>, <code>com</code>, <code>com_new</code>, <code>receipt</code>, <code>root</code>, <code>proof</code>, <code>pubkey</code>, <code>signature</code>. Returns <code>seq</code> and the <code>position</code> of the appended receipt. 422 <code>invalid_proof</code>, 409 <code>stale_commitment</code> (the account moved since <code>com</code>), 409 <code>root_not_recent</code> (older than the last 1024 roots), 503 <code>log_full</code>.</td></tr>
          <tr><td><code>GET /ledger/{ns}/receipts/{pos}/path?size=</code></td><td>none</td><td>a Merkle path for the receipt at <code>pos</code>, against the root at <code>size</code> leaves (default: now): <code>root</code>, <code>leaf</code>, <code>siblings[]</code>, <code>index_bits[]</code></td></tr>
          <tr><td><code>GET /ledger/{ns}/history?from=&amp;limit=</code></td><td>none</td><td><code>ops[]</code> of <code>seq</code>, <code>kind</code> (<code>register</code>, <code>op</code>, <code>mint</code>), <code>envelope</code>, <code>position</code>. <code>from</code> defaults to 1, <code>limit</code> to 100.</td></tr>
          <tr><td><code>GET /ledger/{ns}/accounting</code></td><td>none</td><td><code>minted_total</code>, <code>withdrawn_total</code>, <code>outstanding_liability</code>, <code>receipt_count</code>: the reserve the gateway must hold, as public numbers</td></tr>
        </tbody>
      </table>
    </div>

    ${demoHtml(demos[1])}

    <h2 id="requests">Requests</h2>
    <p>A request is a manifest signed by the receiver's private account: the link id, the
    namespace, the receiving account and key, the amount, a title, a display name, the receiver's
    wallet address, an optional reference and expiry. The node stores it in clear, because the
    payer has to read it. The payer verifies the signature; the node also does, on creation.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>POST /requests</code></td><td>session + account signature</td><td>body: the manifest (<code>version: 2</code>, <code>request_id</code> of 24 base32 characters, <code>namespace</code>, <code>receiver_account</code>, <code>receiver_enc_key</code>, <code>amount</code>, <code>title</code> 1 to 140 characters, <code>display_name</code> 1 to 60, <code>receiver_address</code>, <code>reference</code> up to 64, <code>expires_at</code>, <code>created_at</code> within the last hour, <code>signer_pubkey</code>, <code>signature</code>). 201 with <code>manifest</code>, <code>status: "active"</code>, <code>fulfilled_at</code>, <code>reserved</code>. Idempotent: the same manifest again is 200; a different one under the same id is 409 <code>request_exists</code>. 400 <code>bad_manifest</code>, 400 <code>unregistered_receiver</code>.</td></tr>
          <tr><td><code>GET /requests</code></td><td>session</td><td>the caller's requests, newest first, up to 500. <code>status</code> is <code>active</code>, <code>expired</code>, <code>fulfilled</code> or <code>archived</code>.</td></tr>
          <tr><td><code>GET /requests/{id}?intent=</code></td><td>none</td><td>what a payer reads. <code>reserved</code> is true while another payer holds it; pass your own <code>intent</code> id to see your own reservation as free. 404 <code>unknown_request</code>.</td></tr>
          <tr><td><code>POST /requests/{id}/reserve</code></td><td>none</td><td>body <code>intent_id</code> (8 to 64 characters). A ten minute soft lock so two payers do not race; the same id renews it. Returns <code>reserved_until</code>. 409 <code>reserved</code>, 409 <code>not_payable</code>.</td></tr>
          <tr><td><code>POST /requests/{id}/fulfill</code></td><td>account signature</td><td>body: an acknowledgement signed by the receiving account (<code>request_id</code>, <code>namespace</code>, <code>receiver_account</code>, <code>position</code>, <code>claimed_at</code>, <code>signer_pubkey</code>, <code>signature</code>). Marks the request fulfilled.</td></tr>
          <tr><td><code>POST /requests/{id}/archive</code></td><td>session</td><td>owner only, active only</td></tr>
        </tbody>
      </table>
    </div>
    <p class="dev-note">The reservation is a courtesy between payers, not a rule the ledger
    enforces. Two clients that ignore it can both pay a request; the receiver gets both
    receipts.</p>

    <h2 id="directory">Directory</h2>
    <p>The directory maps a wallet address to a private account, a receiving key and a display
    name, signed by the wallet as EIP-712 <code>PealLinksAccount</code>. Versions form a hash
    chain: each names the previous one's hash, and the node refuses a version that does not.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>PUT /directory</code></td><td>session + wallet signature</td><td>body: the profile (<code>version</code>, <code>wallet</code>, <code>chain_id</code>, <code>namespace</code>, <code>account</code>, <code>enc_key</code>, <code>profile_key</code>, <code>display_name</code>, <code>recovery</code>, <code>nonce</code>, <code>issued_at</code>, <code>expiry</code>, <code>prev</code>, <code>revoked</code>, <code>signature</code>). <code>wallet</code> must be the session's address, and sessions are for externally owned accounts, so although the node can verify an ERC-1271 signature here, a contract wallet cannot publish today. 201 with <code>hash</code>, <code>version</code>, <code>verified</code> (<code>eoa</code> or <code>erc1271</code>). 409 <code>profile_rejected</code>, 400 <code>wrong_chain</code>, 400 <code>unregistered_account</code>.</td></tr>
          <tr><td><code>GET /directory/{ns}/{address}</code></td><td>session</td><td><code>profile</code>, <code>hash</code>, <code>verified</code>, <code>log[]</code> of every version. Rate limited to 60 lookups per session per minute: 429 <code>rate_limited</code>. 404 <code>not_registered</code>.</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="inbox">Inbox</h2>
    <p>A receipt is delivered as an envelope encrypted to the receiver's key: the node stores
    ciphertext, a recipient id and a time. Writing is open, so a payer needs no session; reading
    needs a fresh signature by the receiving account.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>POST /inbox/keys</code></td><td>account signature</td><td>bind an encryption key to an account: <code>namespace</code>, <code>account</code>, <code>enc_pubkey</code>, <code>seq</code>, <code>pubkey</code>, <code>signature</code>. An equal or lower <code>seq</code> is 409 <code>stale_binding</code>.</td></tr>
          <tr><td><code>GET /inbox/keys/{ns}/{acct}</code></td><td>none</td><td>the current binding. 404 <code>no_key</code>.</td></tr>
          <tr><td><code>POST /inbox/{ns}/{acct}</code></td><td>none</td><td>body up to 8 KiB: <code>envelope</code> (<code>version</code>, <code>namespace</code>, <code>recipient</code>, <code>ephemeral</code>, <code>nonce</code> of 24 bytes, <code>ciphertext</code>) and an optional <code>request_id</code>. 201 with <code>id</code>. 400 <code>too_large</code>, 404 <code>unknown_account</code>.</td></tr>
          <tr><td><code>GET /inbox/{ns}/{acct}?after=</code></td><td>header <code>x-peal-inbox-auth</code></td><td>the header is JSON: <code>namespace</code>, <code>account</code>, <code>timestamp</code> within two minutes, <code>pubkey</code>, <code>signature</code>. Up to 200 <code>items</code> after the cursor, each <code>id</code>, <code>envelope</code>, <code>request_id</code>, <code>posted_at</code>.</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="deposits">Deposits</h2>
    <p>A deposit is public on the chain and private on the ledger. The client proves a deposit
    relation over the amount and a random tag, registers the intent, then calls
    <code>gateway.deposit(token, amount, tag)</code>. The node's watcher credits the tag after the
    namespace's confirmations. The tag hides the account; only the holder of the witness can
    claim the credit.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>POST /deposits/intents</code></td><td>proof</td><td>body <code>namespace</code>, <code>circuit_id</code>, <code>amount</code>, <code>receipt</code> (the tag), <code>proof</code>. The proof is verified here. 201 with <code>receipt</code>, <code>status: "pending"</code>; the same tag again is 200. 422 <code>invalid_proof</code>, 400 <code>wrong_circuit</code>.</td></tr>
          <tr><td><code>GET /deposits/intents/{ns}/{receipt}</code></td><td>none</td><td><code>status</code>: <code>pending</code> or <code>minted</code>, with <code>deposit_id</code> and <code>position</code> once credited. 404 <code>unknown_intent</code>.</td></tr>
        </tbody>
      </table>
    </div>
    <div class="doc-callout">
      <p><strong>Register the intent before sending tokens, and keep the witness.</strong> A
      deposit that arrives with a tag the node has never seen is held as unregistered and credited
      when the intent appears. A tag whose witness was lost can never be claimed. And one
      exception to the encoding rule: <code>amount</code> in this body is a JSON number, not a
      string, because the wasm prover emits the envelope. Every other amount on this API is a
      string.</p>
    </div>

    <h2 id="withdrawals">Withdrawals</h2>
    <p>A withdrawal is a send to a fixed burn account, proven like any payment, followed by a
    claim that reveals that one receipt's opening to the node. The settlement signers each check
    the opening against the ledger leaf and sign an EIP-712 <code>Withdrawal</code> for the
    gateway; two of three signatures make a certificate. Anyone can submit it to the chain; the
    recipient is inside the signed message.</p>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>POST /withdrawals</code></td><td>account signature</td><td>body <code>namespace</code>, <code>account</code>, <code>position</code> (of the burn), <code>opening</code> (<code>amount</code>, <code>sender</code>, <code>receiver</code>, <code>randomness</code>), <code>recipient</code>, <code>pubkey</code>, <code>signature</code>. 201 with the certificate: <code>message</code> (<code>chain_id</code>, <code>gateway</code>, <code>token</code>, <code>recipient</code>, <code>amount</code>, <code>withdrawal_id</code>, <code>epoch</code>), <code>signatures[]</code>, <code>signers[]</code>, <code>threshold</code>. Idempotent per burn; re-certified after a signer rotation. 400 <code>bad_opening</code>, 409 <code>already_attested</code>, 503 <code>not_enough_signers</code>, 503 <code>chain_unreachable</code>.</td></tr>
          <tr><td><code>GET /withdrawals/{ns}/{position}</code></td><td>none</td><td><code>status</code>, <code>tx_hash</code> once the watcher sees it on the chain, and the certificate again. 404 <code>unknown_withdrawal</code>.</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="backups">Backups</h2>
    <div class="tcard">
      <table>
        <thead><tr><th>route</th><th>auth</th><th>what</th></tr></thead>
        <tbody>
          <tr><td><code>PUT /backups/{ns}</code></td><td>session</td><td>body <code>seq</code>, <code>mechanism</code> (<code>wallet-signature</code> or <code>recovery-code</code>), <code>blob</code>: opaque ciphertext up to 1 MiB, keyed by the session's address. A lower <code>seq</code> is 409 <code>backup_rejected</code>. The node keeps the last 8 versions.</td></tr>
          <tr><td><code>GET /backups/{ns}</code></td><td>session</td><td><code>seq</code>, <code>mechanism</code>, <code>blob</code>, <code>created_at</code>. 404 <code>no_backup</code>.</td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="errors">Errors</h2>
    <p>Every error is <code>application/problem+json</code> with the same five fields. Match on
    <code>code</code>; the <code>detail</code> is for a human.</p>
    <pre class="doc-code"><code>{
  "type": "https://peal.network/problems/stale_commitment",
  "title": "stale commitment",
  "status": 409,
  "code": "stale_commitment",
  "detail": "the account's commitment moved since this proof was made"
}</code></pre>
    <div class="tcard">
      <table>
        <thead><tr><th>status</th><th>codes</th></tr></thead>
        <tbody>
          <tr><td>400</td><td><code>malformed</code>, <code>unknown_namespace</code> (in a body; 404 on a path), <code>wrong_namespace</code>, <code>wrong_circuit</code>, <code>wrong_chain</code>, <code>bad_siwe</code>, <code>bad_manifest</code>, <code>bad_profile</code>, <code>bad_opening</code>, <code>too_large</code>, <code>unregistered_receiver</code>, <code>unregistered_account</code>, <code>wallet</code></td></tr>
          <tr><td>401</td><td><code>unauthorized</code>: no session, an expired one, a bad account signature, a stale inbox header</td></tr>
          <tr><td>404</td><td><code>unknown_namespace</code>, <code>unknown_account</code>, <code>unknown_request</code>, <code>unknown_intent</code>, <code>unknown_withdrawal</code>, <code>unknown_param</code>, <code>not_registered</code>, <code>no_key</code>, <code>no_backup</code>, <code>single_node</code></td></tr>
          <tr><td>409</td><td><code>account_exists</code>, <code>stale_commitment</code>, <code>root_not_recent</code>, <code>request_exists</code>, <code>reserved</code>, <code>not_payable</code>, <code>stale_binding</code>, <code>profile_rejected</code>, <code>backup_rejected</code>, <code>already_attested</code>, <code>already_consumed</code>, <code>duplicate_deposit</code></td></tr>
          <tr><td>422</td><td><code>invalid_proof</code></td></tr>
          <tr><td>429</td><td><code>rate_limited</code></td></tr>
          <tr><td>503</td><td><code>log_full</code>, <code>no_gateway</code>, <code>no_committee</code>, <code>no_consensus</code>, <code>not_enough_signers</code>, <code>chain_unreachable</code></td></tr>
        </tbody>
      </table>
    </div>

    <h2 id="limits">Limits</h2>
    <div class="tcard">
      <table>
        <thead><tr><th>what</th><th>limit</th></tr></thead>
        <tbody>
          <tr><td>any request body</td><td>256 KiB</td></tr>
          <tr><td>an inbox envelope</td><td>8 KiB</td></tr>
          <tr><td>a backup blob</td><td>1 MiB, last 8 versions kept</td></tr>
          <tr><td>a sign-in message</td><td>4096 characters; nonce good for 10 minutes; session 12 hours</td></tr>
          <tr><td>directory lookups</td><td>60 per session per minute</td></tr>
          <tr><td>a request reservation</td><td>10 minutes</td></tr>
          <tr><td>a payment intent</td><td>10 minutes</td></tr>
          <tr><td>inbox page, request list</td><td>200 items, 500 requests</td></tr>
          <tr><td>proof age</td><td>the root must be among the last 1024</td></tr>
        </tbody>
      </table>
    </div>
    <p>Cross-origin calls are allowed from any origin with <code>GET</code>, <code>POST</code>,
    <code>PUT</code> and <code>OPTIONS</code>, and the request headers <code>content-type</code>,
    <code>accept</code>, <code>authorization</code>, <code>if-none-match</code> and
    <code>x-peal-inbox-auth</code>; <code>etag</code> and <code>x-peal-digest</code> are exposed.
    There is no API key and no per-IP limit beyond the ones above.</p>

    <h2 id="dev">Running your own node</h2>
    <p>The node is one Rust binary with a JSON profile: chains, tokens, gateways, confirmations,
    the accepted sign-in domains, and the settlement signer keys. With <code>dev_mint</code> on, it
    also mounts <code>POST /dev/mint</code>, which credits a pending deposit intent without a chain
    event, for local development only; the node refuses that flag with any mainnet namespace.
    The <a href="https://github.com/Adityaakr/peal-network/blob/main/docs/peal-links/OPERATIONS.md" target="_blank" rel="noopener">operations guide</a>
    covers the local stack, a public testnet and hosting.</p>

    <h2 id="next">Where to go next</h2>
    <ul class="doc-list">
      <li><a href="#/developers/links-sdk">Private Links SDK</a> does every call above with the
      proofs, envelopes and signatures handled.</li>
      <li><a href="#/developers/links">Peal Private Links</a> is the picture: the pieces and who
      sees what.</li>
      <li><a href="https://github.com/Adityaakr/peal-network/blob/main/crates/peal-links-node/src/api.rs" target="_blank" rel="noopener">The route handlers</a>
      are the source of truth for every field on this page.</li>
    </ul>`,
  mount(root) {
    return wireDemos(root, demos, { bidders: 0 });
  },
};

import type { DocsPage } from '../../docs';
import { shown } from './runner';

export const roadmap: DocsPage = {
  title: 'Roadmap',
  lede: 'Peal Commit, paid access, and what is live against what is not, stated plainly.',
  html: `
<h2>Peal Commit</h2>
        <p>The rounds API above is the general shape: many seals, one deadline. Most callers, and
        nearly every agent, want the narrow one: seal a thing until a time, get something back that
        proves it was sealed before it was opened. That is one call.</p>

        <pre class="dev-code"><code>POST ${shown}/v1/seals

{
  "ciphertext_b64": "…",             // encrypted on your side, always
  "unlock_at":      "2026-09-12T18:00:00Z",
  "tag":            "my-app"
}

→ {
  "id":         "4f858dc3…",         // sha256 of the ciphertext
  "round_id":   "cond_…",
  "unlock_at":  "2026-09-12T18:00:00Z",
  "proof_url":  "/v1/seals/4f858dc3…/proof"
}</code></pre>

        <p>Or with the client, which does the encryption:</p>
        <pre class="dev-code"><code>import { peal } from '${shown}/peal.js';

const until = '2026-09-12T18:00:00Z';
const { id, proof_url } = await peal.sealUntil('the bid', until);
const proof = await peal.getProof(id);</code></pre>

        <p class="dev-note"><strong>There is no field that takes a plaintext.</strong> Encrypting
        on our side would move the encryption to the wrong end of the network and delete the only
        property this has. The payload is a ciphertext or it is not accepted.</p>

        <h3>What the proof actually proves</h3>
        <p><code>GET /v1/seals/{id}/proof</code> returns the checkable facts and nothing else. The
        load-bearing one is <code>ordering_committed_at</code>: the coordinator writes the batch's
        ordering root at freeze, before any operator is handed work, so a commitment timestamp
        earlier than the reveal is evidence that the set and its order were fixed before anybody
        could open it. Before the round opens, the reveal fields are <code>null</code> rather than
        <code>false</code>, because "not yet" and "no" are different answers.</p>
        <pre class="dev-code"><code>{
  "seal_id":       "4f858dc3…",   // recompute it yourself
  "position":      3,             // from the hashes, not arrival
  "ordering_root": "0x…",
  "ordering_committed_at": 1788490917,
  "merkle_root":   "0x…",
  "revealed_at":   1788494517,
  "commitment_precedes_reveal": true,
  "threshold":     "3 of 5 operators open a batch"
}</code></pre>

        <h3>What is built, and what is not</h3>
        <p>Every endpoint on this page is live and every example runs against the network. These
        are the pieces that are not, so you can see the edge of the thing before you plan around
        it.</p>
        <ul class="dev-status">
          <li><span class="dev-st dev-st-live">live</span><code>POST /v1/seals</code>
            <em>seal until a time, in one call</em></li>
          <li><span class="dev-st dev-st-live">live</span><code>GET /v1/seals/{id}/proof</code>
            <em>ordering commitment, merkle root, threshold</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span><code>webhook</code> on a seal
            <em>we would call you at the deadline; today you poll the round, which an ETag makes
            nearly free</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span><code>POST /v1/rounds</code> with
            an invite list <em>multi-party rounds where the participants are known up front</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>MCP tool
            <code>seal_until(payload, unlockAt)</code> <em>so an agent can reach this without an
            SDK</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>paid access over
            <a href="https://docs.x402.org/introduction" target="_blank" rel="noopener">x402</a>
            <em>pay per call in a request, no account; the devnet is free and unmetered</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>typed SDKs for TypeScript, Python
            and Go <em>peal.js and plain HTTP cover it today</em></li>
          <li><span class="dev-st dev-st-live">live</span>sealed bid auctions
            <em>reserve, maximum, ranking, the queue, replay rejection and encrypted contact
            details</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span>currency conversion in the API
            <em>bidders in another currency; peal-live does it client side today</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span>claiming a short link from the
            API <em>you can check availability today; claiming is a permanent onchain write and
            happens from your own key</em></li>
        </ul>
        <p class="dev-note">An agent cannot sign up for anything: it cannot accept terms, hold an
        API key it did not earn, or expense a subscription. It can pay for one request. That is why
        per-call payment is on this list rather than a plan and a dashboard.</p>`,
};

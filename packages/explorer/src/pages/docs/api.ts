import type { DocsPage } from '../../docs';
import { shown } from './runner';
import { esc } from '../../util';

export const apiReference: DocsPage = {
  title: 'API reference',
  lede: 'Every endpoint, with the error codes and the rate limit headers. Plain JSON over HTTP, no key.',
  html: `
<h2>API reference</h2>
        <p>Base URL <code>${esc(shown)}</code>. Everything is JSON. Nothing here needs a key.</p>
        <div class="dev-endpoints">
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/rounds</code></p>
            <p>Open a round. One of <code>opens_in</code> (seconds), <code>opens_at</code> (RFC 3339
            or unix seconds) or <code>opens_at_block</code> (<code>chain_id</code> +
            <code>height</code>), plus an optional <code>tag</code>. <code>title</code>,
            <code>description</code> and <code>image_url</code> describe the round publicly and
            come back on every read, including the list, so a gallery needs one request rather than
            one per tile. <code>image_url</code> must be https. Send an
            <code>Idempotency-Key</code> header and a retry returns the same round with 200 instead
            of creating a second one. 201 and a <code>Location</code> on success.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds</code></p>
            <p>Your rounds, newest first. Filter with <code>tag</code> and <code>status</code>
            (<code>open</code>, <code>closing</code>, <code>opened</code>, <code>stalled</code>),
            page with <code>limit</code> and <code>cursor</code>. Returns
            <code>{ data, next_cursor, has_more }</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds/{id}</code></p>
            <p>One round at any stage, always 200, with <code>status</code>, <code>seals</code>,
            <code>opens_at</code> and <code>opened_at</code>. Carries an <code>ETag</code>: send
            <code>If-None-Match</code> while you wait and get 304s until something changes.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/rounds/{id}/seals</code></p>
            <p>Submit a ciphertext: <code>{ ciphertext_b64 }</code>. Parsed, on curve and subgroup
            checked before it is stored. The seal's <code>id</code> is the SHA-256 of the
            ciphertext, so the same submission twice is the same seal and needs no idempotency key.
            409 once the round has closed.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds/{id}/seals</code></p>
            <p>Every seal in the round. Ids and positions while it is open; the same shape with
            <code>payload_b64</code> filled in once it has opened.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/seals/{id}</code></p>
            <p>One seal, with its payload once the round has opened.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/auctions</code></p>
            <p>A round with auction rules: <code>currency</code>, <code>decimals</code>,
            <code>reserve_minor</code>, <code>maximum_minor</code>, <code>contact_public_key</code>,
            plus the round's own <code>closes_in</code>/<code>closes_at</code>, title, description
            and picture. Rules that cannot be satisfied, like a maximum below the reserve, are
            refused here rather than at the close.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/currencies</code></p>
            <p>The 56 currencies the API knows, with the decimals each one uses. Search with
            <code>q</code> by code, name or symbol. Pass a known code when you create an auction
            and the decimals come with it.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/names/{name}</code></p>
            <p>Whether a short link is free. Checking only: claiming is a permanent onchain write
            that can never be undone, so it happens from your own key rather than from a server
            acting on your behalf.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/auctions/{id}/bids</code></p>
            <p>A bid is a seal: <code>{ ciphertext_b64 }</code> holding the fixed width record. Same
            validation and the same closed check as any other seal.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/auctions/{id}/results</code></p>
            <p>Every readable bid ranked, the queue the rules allow to win, the winner, the count of
            decoys, and anything discarded with its reason. Before the close, <code>bids</code> is
            null rather than an empty list, so "not open yet" cannot be read as "no bids".</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/seals</code></p>
            <p>One payload, one deadline, one call: <code>{ ciphertext_b64, unlock_at }</code> or
            <code>unlock_in</code>, plus an optional <code>tag</code> and <code>title</code>.
            Creates a round holding just this seal and returns its id and a proof URL. Validated by
            the same code as the two-step form, so no rule can hold on one and not the other.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/seals/{id}/proof</code></p>
            <p>What can be checked: the ordering root and when it was committed, the merkle root,
            the position, and whether the commitment preceded the reveal. Null rather than false
            before the round opens.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/parameters</code></p>
            <p>The public key material to encrypt against, with the digest a client checks before
            using it, plus <code>operators</code>, <code>threshold</code> and
            <code>batch_size</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1</code></p>
            <p>What this deployment accepts: payload cap, page sizes, rate limits, idempotency
            window. Read it rather than hard-coding limits from prose.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-file">FILE</span> <code>/peal.js</code></p>
            <p>The client as one ES module with the encryption compiled in:
            <code>createRound</code>, <code>seal</code>, <code>getRound</code>,
            <code>listRounds</code>, <code>listSeals</code>, <code>getSeal</code>,
            <code>getPayloads</code>, <code>waitForOpen</code>. Browsers and Node.</p>
          </div>
        </div>

        <h3>Errors</h3>
        <p>Every failure is <a href="https://www.rfc-editor.org/rfc/rfc9457" target="_blank"
        rel="noopener">RFC 9457</a> problem+json with a stable <code>code</code> to branch on and a
        <code>field</code> when one input is at fault. <code>detail</code> is for humans and its
        wording is not part of the contract.</p>
        <pre class="dev-code"><code>{
  "type":   "https://peal.network/#/developers#invalid_tag",
  "title":  "invalid request",
  "status": 400,
  "code":   "invalid_tag",
  "detail": "a tag is up to 32 characters of a-z 0-9 : - _",
  "field":  "tag"
}</code></pre>
        <p>Codes you can expect: <code>missing_deadline</code>, <code>opens_in_past</code>,
        <code>invalid_time</code>, <code>invalid_tag</code>, <code>invalid_cursor</code>,
        <code>invalid_status</code>, <code>invalid_base64</code>, <code>invalid_ciphertext</code>,
        <code>payload_too_large</code>, <code>round_closed</code>, <code>not_found</code>.</p>

        <h3>Rate limits</h3>
        <p>Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and
        <code>RateLimit-Reset</code>, so you can see your budget without having to be refused to
        learn it.</p>

        <h3>v0</h3>
        <p>The older surface (<code>/v0/conditions</code>, <code>/v0/ciphertexts</code>,
        <code>/v0/reveals</code>) is unchanged and still serves every existing client. New
        integrations should use v1.</p>
        </div>`,
};

// The protocol reference as an editorial article: warm cards for formulas
// and tables, a dark code card, clean comparison/state/architecture
// diagrams. Same content spine as docs/protocol.html; every claim traces to
// spec/index.md or the coordinator/SDK code. Keep both in sync.
import { mountScrollReveal } from '../reveal';

const sections = [
  ['overview', 'Overview'],
  ['problem', 'The problem'],
  ['compare', 'Alternatives'],
  ['lifecycle', 'Lifecycle'],
  ['engine', 'Engine'],
  ['crypto', 'Cryptography'],
  ['ceremony', 'Ceremony'],
  ['privacy', 'Private seals'],
  ['architecture', 'Architecture'],
  ['byzantine', 'Byzantine drill'],
  ['integration', 'Building on it'],
  ['numbers', 'Numbers'],
  ['production', 'Production'],
  ['trust', 'Trust model'],
] as const;

/** The page as a string, with nothing touched in the document. Rendered into
 * the document by `renderProtocol` and into a static file by src/prerender.ts, so a
 * reader with no JavaScript gets the same words a browser does. */
export function protocolHtml(): string {
  return `
    <article class="protocol-article">
      <header id="overview" class="scroll-reveal">
        <p class="kicker">Peal protocol reference · v0</p>
        <h1>How Peal guarantees every reveal.</h1>
        <p class="lede">Peal is a programmable encryption network for information that must stay
        unreadable until a shared condition fires. A browser seals a payload once. A threshold
        committee later opens the whole batch, publicly and verifiably. Nobody returns for a
        second reveal transaction. This article walks the protocol end to end: the cryptography
        that makes early reading impossible, the machinery that makes the reveal guaranteed, how
        to build on it, and exactly what separates today's devnet from production.</p>
        <div class="facts" aria-label="protocol defaults">
          <div><span>committee</span><strong>n = 5</strong></div>
          <div><span>threshold</span><strong>t = 3</strong></div>
          <div><span>fixed batch</span><strong>B = 64</strong></div>
          <div><span>crypto overhead</span><strong>64 bytes</strong></div>
          <div><span>share size</span><strong>48 bytes</strong></div>
          <div><span>stall timeout</span><strong>120 s</strong></div>
        </div>
      </header>

      <nav class="protocol-nav" aria-label="protocol sections">
        ${sections.map(([id, label], index) => `<button type="button" data-section="${id}"${index === 0 ? ' aria-current="true"' : ''}>${label}</button>`).join('')}
      </nav>

      <section class="scroll-reveal">
        <h2 id="problem">The problem</h2>
        <p>Commit-reveal is the standard way to hide information on a public ledger until a
        deadline: users post a hash now and the preimage later. The pattern is sound cryptography
        wrapped around a broken assumption, that people will come back. The bidder who lost never
        opens their commitment, and the auction cannot distinguish a griefing bidder from a
        crashed one. The voter who saw the early tally shift never reveals. The game player whose
        move became bad simply forfeits the reveal and eats a smaller penalty than the move would
        have cost.</p>
        <p>Every application built on voluntary reveal inherits the same design tax: reveal
        windows and their timeout parameters, slashing deposits sized to guess at the value of
        hiding, incomplete datasets, and a support queue of users who missed their window
        honestly. The failure is structural. If revealing is a user action, the user can decline
        it exactly when declining matters most.</p>

        <figure>
          <svg class="diagram" viewBox="0 0 860 460" role="img" aria-label="Comparison: ordinary commit-reveal makes the reveal a user action that can be abandoned; Peal makes the reveal a network duty performed by a threshold committee">
            <text x="215" y="44" text-anchor="middle" font-size="26" class="serif" fill="#1f2430">commit-reveal</text>
            <text x="215" y="70" text-anchor="middle" font-size="14" class="m" fill="#2563eb">reveal is a user action</text>
            <rect x="80" y="94" width="270" height="56" rx="12" fill="#dbe7f8" stroke="#1f2937" stroke-width="1.5"/>
            <text x="215" y="127" text-anchor="middle" font-size="15.5" font-weight="500" fill="#1f2430">user posts hash(bid, salt)</text>
            <path d="M215 150 L215 176" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M209 168 L215 178 L221 168" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="80" y="180" width="270" height="56" rx="12" fill="#e6dff5" stroke="#1f2937" stroke-width="1.5"/>
            <text x="215" y="207" text-anchor="middle" font-size="15.5" font-weight="500" fill="#1f2430">deadline passes</text>
            <text x="215" y="226" text-anchor="middle" font-size="12.5" fill="#6b7280">everyone waits</text>
            <path d="M215 236 L215 262" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M209 254 L215 264 L221 254" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="80" y="266" width="270" height="66" rx="12" fill="#f6eec6" stroke="#1f2937" stroke-width="1.5"/>
            <text x="215" y="294" text-anchor="middle" font-size="15.5" font-weight="700" fill="#1f2430">user must return and reveal</text>
            <text x="215" y="314" text-anchor="middle" font-size="12.5" fill="#6b7280">a second transaction, voluntarily</text>
            <path d="M215 332 L215 358" stroke="#1f2937" stroke-width="1.5" stroke-dasharray="5 4"/>
            <path d="M209 350 L215 360 L221 350" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="80" y="362" width="270" height="66" rx="12" fill="#fbe3df" stroke="#1f2937" stroke-width="1.5"/>
            <text x="215" y="390" text-anchor="middle" font-size="15.5" font-weight="500" fill="#1f2430">or they simply do not</text>
            <text x="215" y="410" text-anchor="middle" font-size="12.5" fill="#6b7280">unopened commitments break the app</text>
            <line x1="430" y1="30" x2="430" y2="436" stroke="#e7e2d9" stroke-width="1.5"/>
            <text x="645" y="44" text-anchor="middle" font-size="26" class="serif" fill="#1f2430">Peal</text>
            <text x="645" y="70" text-anchor="middle" font-size="14" class="m" fill="#16a34a">reveal is a network duty</text>
            <rect x="510" y="94" width="270" height="56" rx="12" fill="#f1f0ee" stroke="#1f2937" stroke-width="1.5"/>
            <text x="645" y="122" text-anchor="middle" font-size="15.5" font-weight="500" fill="#1f2430">user seals ciphertext, once</text>
            <text x="645" y="141" text-anchor="middle" font-size="12.5" fill="#6b7280">encrypted in the browser, in wasm</text>
            <path d="M645 150 L645 176" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M639 168 L645 178 L651 168" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="510" y="180" width="270" height="66" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.8"/>
            <text x="645" y="208" text-anchor="middle" font-size="15.5" font-weight="700" fill="#1f2430">the cue fires</text>
            <text x="645" y="228" text-anchor="middle" font-size="12.5" fill="#6b7280">wall clock or block height, batch freezes</text>
            <path d="M645 246 L645 272" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M639 264 L645 274 L651 264" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="510" y="276" width="270" height="86" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.8"/>
            <text x="645" y="306" text-anchor="middle" font-size="15.5" font-weight="700" fill="#1f2430">the committee reveals the batch</text>
            <text x="645" y="326" text-anchor="middle" font-size="12.5" fill="#6b7280">any t of n shares, publicly verified</text>
            <text x="645" y="345" text-anchor="middle" font-size="12.5" fill="#6b7280">every slot opens, including losers</text>
            <text x="645" y="398" text-anchor="middle" font-size="13" class="m" fill="#6b7280">no second transaction exists</text>
            <text x="645" y="418" text-anchor="middle" font-size="13" class="m" fill="#6b7280">(nothing for the user to abandon)</text>
          </svg>
          <figcaption>The structural difference: commit-reveal ends in a step the user can skip.
          Peal has no such step.</figcaption>
        </figure>

        <p>Peal removes the action. The payload is encrypted rather than hashed, and decryption
        is a network duty rather than a user choice. Before the cue, fewer than
        <span class="mono">t</span> committee operators can recover nothing, and that includes
        the coordinator that stores the ciphertexts. After the cue, any
        <span class="mono">t</span> valid shares recover every slot in the frozen batch at once.
        The user's only action is the seal.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="compare">Why threshold, not the alternatives</h2>
        <p>Guaranteed reveal has four other known constructions. Each carries a cost Peal was
        built to avoid, and each has real uses; the table is a scoping tool, not a dismissal.</p>
        <div class="tcard">
          <table>
            <thead><tr><th>approach</th><th>how it reveals</th><th>the catch</th></tr></thead>
            <tbody>
              <tr><td>timelock puzzle / VDF</td><td>anyone grinds sequential computation until the
              plaintext falls out</td><td>the deadline is denominated in compute, not clock
              time; someone must actually run the grind, and faster hardware moves the
              deadline</td></tr>
              <tr><td>drand tlock</td><td>a long-running threshold beacon, the League of Entropy,
              publishes a BLS signature every round; you encrypt to a future round number and
              anyone decrypts with that round's signature</td><td>the schedule is the beacon's
              rounds, 3 s or 30 s of wall clock, not your condition, and there is no block-height
              cue; every ciphertext for a round opens for everyone with the same signature, one at
              a time, and there is no batch, so nothing pads or hides how many were sealed</td></tr>
              <tr><td>TEE-held keys</td><td>an enclave releases the key at the
              deadline</td><td>the guarantee is the vendor's attestation chain; one enclave
              break is a total, silent compromise</td></tr>
              <tr><td>naked threshold</td><td>a committee decrypts each ciphertext on
              request</td><td>per-ciphertext work: n operators each touch every message, which
              is exactly what kills throughput at batch sizes that matter</td></tr>
              <tr><td>peal (batched)</td><td>a committee posts one constant-size share per
              operator per batch</td><td>batches are fixed at B slots and a threshold of
              operators must be live; the v0 ceremony still has a trusted dealer</td></tr>
            </tbody>
          </table>
        </div>
        <p>The batching is the point. One 48-byte share per operator opens up to 64 payloads, so
        the committee's work per reveal is constant while the batch fills. Wall-clock deadlines
        stay wall-clock. And every share is publicly verifiable against published keys, so a
        lying operator is caught by arithmetic, not by reputation. Detection is live today; the
        remedy is not: replacing a caught operator currently means a new ceremony.</p>
        <h3 id="tlock">Why not drand tlock</h3>
        <p>tlock deserves its own paragraph because it is the closest neighbour, not a strawman. It
        is the same primitive family, threshold BLS over BLS12-381. It has run in production since
        2020. Its own documentation lists the same applications this site does: sealed-bid
        auctions, MEV prevention, voting, responsible vulnerability disclosure. And the League of
        Entropy is a genuinely multi-organisation committee, Cloudflare, EPFL, Protocol Labs,
        Kudelski Security and around twenty other named members, which Peal's devnet is not. If
        what you need is a public wall-clock unlock and nothing else, tlock is the mature answer
        and you should use it.</p>
        <p>Peal differs in three specific ways. <strong>The condition is yours.</strong> A tlock
        ciphertext opens at a beacon round, which is a point in wall-clock time; a Peal condition
        is a deadline or a block height on a chain you name, and the cue is a row the coordinator
        fires rather than a signature somebody else's schedule produces. <strong>The unit is a
        round, not a ciphertext.</strong> Up to 64 payloads share one batch; one 48-byte share per
        operator opens all of them, so committee traffic per reveal is constant while the batch
        fills. The batch is padded with decoys, so while a round is open nothing says how many
        were sealed, and once it opens the count is still padded. tlock has no batch: each
        ciphertext is independent, and a public count of ciphertexts encrypted to a round is
        exactly the number a competitor in a sealed auction wants. <strong>It is HTTP with no
        chain.</strong> Three calls seal and open a round; a chain enters only when you anchor a
        root to one.</p>
        <p>Two things this comparison must not say. Neither scheme is post-quantum: both rest on
        pairings, and drand says so of tlock in its own docs. And batching saves coordination and
        bandwidth, not pairings: the paper is explicit that decryption costs a few pairings per
        ciphertext in every scheme, its own included. What Peal does not have yet is tlock's
        operator diversity. Today's committee is five processes we run, and until distributed key
        generation and named third-party operators land, tlock's trust model is the stronger
        one.</p>
        <p class="fine">Sources: <a href="https://docs.drand.love/docs/timelock-encryption/" target="_blank" rel="noopener">drand, timelock encryption</a>
        (mechanism, the applications list, the stated limitations) ·
        <a href="https://github.com/drand/tlock" target="_blank" rel="noopener">drand/tlock</a> (round or
        duration as the only triggers) · <a href="https://drand.love/about/" target="_blank" rel="noopener">drand, about</a>
        (beacon cadence, League of Entropy membership) ·
        <a href="https://eprint.iacr.org/2026/760" target="_blank" rel="noopener">Policharla, A Simple Batched Threshold Encryption Scheme, ePrint 2026/760</a>
        (48-byte shares, the per-ciphertext pairing floor).</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="lifecycle">What one payload goes through</h2>
        <ol class="steps">
          <li><div>
            <h3>Fetch committee parameters</h3>
            <p>The SDK downloads the public parameters, checks their SHA-256 digest, and caches
            them. The parameter set fixes n, t and B for the committee's lifetime, and the wasm
            module re-parses it independently, so a tampered parameter blob fails twice.</p>
            <span class="api">GET /v0/committees/:id</span>
          </div></li>
          <li><div>
            <h3>Seal in the browser</h3>
            <p>Wasm runs the Fujisaki-Okamoto transform locally. Only the sealed wire bytes ever
            leave the device; for a short text payload that is about 110 bytes total. The
            plaintext never exists outside the tab that typed it.</p>
            <span class="api">seal(payload, conditionId)</span>
          </div></li>
          <li><div>
            <h3>Content-address the ciphertext</h3>
            <p>The coordinator parses the wire format, enforces the payload cap, computes
            ct_hash = sha256(wire), and stores the blob under its condition. The hash is the
            stable handle an application keeps; submission order does not choose the slot.</p>
            <span class="api">POST /v0/ciphertexts</span>
          </div></li>
          <li><div>
            <h3>The cue fires, the batch freezes</h3>
            <p>A wall-clock or block-height condition fires. The coordinator pads to 64 slots
            with self-sealed dummies, sorts every ciphertext by hash, assigns positions, and
            makes the batch immutable. Positions are a pure function of the ciphertext set: two
            coordinators given the same seals produce the same board.</p>
            <span class="api">pending &rarr; frozen</span>
          </div></li>
          <li><div>
            <h3>Operators post one share each</h3>
            <p>Each outbound-only node polls for frozen work, decrypts its local keystore, and
            computes one 48-byte partial for the entire batch. The share is the same size
            whether the batch holds one sealed order or sixty-four.</p>
            <span class="api">GET /v0/work &middot; POST /v0/shares</span>
          </div></li>
          <li><div>
            <h3>Verify, combine, recover</h3>
            <p>Every share must pass a public pairing check before it counts. Any t valid shares
            are Lagrange-combined once for the whole batch, and a per-slot integrity check
            isolates any mauled ciphertext to its own slot.</p>
            <span class="api">frozen &rarr; revealed</span>
          </div></li>
          <li><div>
            <h3>Publish an auditable record</h3>
            <p>The reveal carries every slot, its validity bit, the full operator share log with
            timings, and a merkle root over position and payload. Anyone can recompute the root
            from the published batch.</p>
            <span class="api">GET /v0/reveals/:id</span>
          </div></li>
        </ol>

        <figure>
          <svg class="diagram" viewBox="0 0 820 210" role="img" aria-label="Condition lifecycle: pending accepts seals, the cue freezes the batch, t valid shares reveal it; a timeout without t shares stalls the condition until a late share completes it">
            <rect x="24" y="42" width="180" height="66" rx="12" fill="#dbe7f8" stroke="#1f2937" stroke-width="1.5"/>
            <text x="114" y="70" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">pending</text>
            <text x="114" y="91" text-anchor="middle" font-size="12.5" fill="#6b7280">accepting seals</text>
            <path d="M204 75 L268 75" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M260 69 L270 75 L260 81" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <text x="237" y="62" text-anchor="middle" font-size="12.5" class="m" fill="#2563eb">cue fires</text>
            <rect x="272" y="42" width="180" height="66" rx="12" fill="#f1f0ee" stroke="#1f2937" stroke-width="1.5"/>
            <text x="362" y="70" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">frozen</text>
            <text x="362" y="91" text-anchor="middle" font-size="12.5" fill="#6b7280">collecting shares</text>
            <path d="M452 75 L516 75" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M508 69 L518 75 L508 81" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <text x="485" y="62" text-anchor="middle" font-size="12.5" class="m" fill="#2563eb">t valid shares</text>
            <rect x="520" y="42" width="196" height="66" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.8"/>
            <text x="618" y="70" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">revealed</text>
            <text x="618" y="91" text-anchor="middle" font-size="12.5" fill="#6b7280">immutable, auditable</text>
            <path d="M362 108 L362 146 L410 146" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>
            <path d="M402 140 L412 146 L402 152" fill="none" stroke="#dc2626" stroke-width="1.5"/>
            <text x="284" y="140" text-anchor="middle" font-size="12" fill="#6b7280">fewer than t in 120 s</text>
            <rect x="414" y="120" width="196" height="52" rx="12" fill="#fbe3df" stroke="#1f2937" stroke-width="1.5"/>
            <text x="512" y="151" text-anchor="middle" font-size="14.5" font-weight="500" fill="#1f2430">stalled</text>
            <path d="M610 146 C660 146, 660 112, 630 108" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>
            <path d="M640 104 L628 108 L638 116" fill="none" stroke="#16a34a" stroke-width="1.5"/>
            <text x="702" y="150" text-anchor="middle" font-size="12" class="m" fill="#16a34a">one late valid share</text>
          </svg>
          <figcaption>The condition state machine. Stalled is honest, not terminal: a late valid
          share resumes recovery, and a condition is never falsely revealed.</figcaption>
        </figure>
      </section>

      <section class="scroll-reveal">
        <h2 id="engine">The condition engine</h2>
        <p>The coordinator's scheduler is a 500 ms tick loop, not a callback registry. Each pass
        it freezes any pending wall-clock condition whose time has come, polls configured RPC
        endpoints with <span class="mono">eth_blockNumber</span> for block-height conditions,
        finalizes any frozen batch that has reached t verified shares, and marks conditions
        stalled when the reveal timeout (default 120 seconds,
        <span class="mono">REVEAL_TIMEOUT_SECS</span>) passes without them.</p>
        <p>Two properties matter more than the loop itself. Freezing is deterministic: positions
        derive from sorting ciphertext hashes, so the frozen board is reproducible by anyone
        holding the ciphertext set, and an integration test asserts two coordinators agree. And
        every step is idempotent against restart: state reloads from the database, the expensive
        cross-terms are recomputed rather than trusted from cache, and operator nodes simply
        repoll. Killing the coordinator mid-reveal delays the reveal; it cannot corrupt it.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="crypto">The cryptography</h2>
        <p>Peal wraps Commonware's batched threshold encryption
        (<a class="link" href="https://eprint.iacr.org/2026/760" target="_blank" rel="noopener">eprint 2026/760</a>
        by Guru Vamsi Policharla, implemented in
        <a class="link" href="https://github.com/commonwarexyz/simple-bte" target="_blank" rel="noopener">simple-bte</a>)
        without modifying the scheme. The wrapper adds conditions, persistence, operator
        transport, share verification, and public records. Nothing below is novel cryptography;
        that is deliberate.</p>

        <h3>The wire format</h3>
        <p>A sealed ciphertext is a fixed header and a masked body. The cryptographic overhead
        is 64 bytes: a 48-byte KEM header and a 16-byte key mask. Framing adds 9 more.</p>
        <div class="eq">
          <div><span>magic + type</span><code>"BTE0" || 0x01, 5 bytes</code></div>
          <div><span>KEM header</span><code>ct&#8320; = [k]&#8321;, 48 bytes compressed G1</code></div>
          <div><span>masked key</span><code>ct&#8321; = H&#8342;([k &middot; &tau;<sup>B+1</sup>]&#8348;) xor K, 16 bytes</code></div>
          <div><span>masked body</span><code>ct&#8322; = H&#8344;(K) xor payload</code></div>
          <div><span>integrity</span><code>k = H&#7523;(K, payload), verify [k]&#8321; = ct&#8320;</code></div>
        </div>
        <p>The last line is the Fujisaki-Okamoto discipline that makes the scheme non-malleable
        in practice: the ephemeral scalar is not random at decryption time, it is re-derived
        from the recovered plaintext. A ciphertext anyone tampered with recovers to a plaintext
        whose re-derived scalar fails to reproduce the KEM header, so the slot is flagged
        corrupt and quarantined without poisoning the other 63.</p>

        <h3>The punctured setup</h3>
        <p>The ceremony publishes powers of a secret <span class="mono">&tau;</span> with one
        deliberate hole. Everyone can encrypt toward the missing power. Nobody holds it. That
        hole is the entire trick.</p>
        <div class="eq">
          <div><span>published</span><code>[&tau;<sup>j</sup>]&#8322; for j = 0 &hellip; 2B, except j = B+1 (zeroed)</code></div>
          <div><span>encryption key</span><code>ek = [&tau;<sup>B+1</sup>]&#8348;, target group only</code></div>
          <div><span>dealt to operators</span><code>Shamir shares of &tau;&sup1; &hellip; &tau;<sup>B</sup>, threshold t of n</code></div>
          <div><span>per-operator public</span><code>verification values v&#7522;&#690;</code></div>
        </div>
        <p>Why it works, in one paragraph. Sealing masks the payload key with
        <span class="mono">[k &middot; &tau;<sup>B+1</sup>]&#8348;</span>. That value lives in
        the pairing's target group, where you cannot climb from
        <span class="mono">[&tau;<sup>j</sup>]</span> to
        <span class="mono">[&tau;<sup>j+1</sup>]</span>; the one power that would let you compute
        it directly was zeroed out of the published set, and its preimage was destroyed at setup
        (in v0, that destruction is the dealer's promise; see the trust model). What the batch
        structure buys is a way to route around the hole: pairing each ciphertext header against
        the right published powers produces cross-terms in which the unknown power appears only
        multiplied by the operators' secret-shared low powers. Add t operators' contributions
        and the unknown cancels into something computable; with fewer than t, it is still hidden
        behind Shamir secrecy. The published powers run to 2B precisely so those cross-terms
        exist for every slot position.</p>
        <p>This is also why every batch is exactly B slots. The setup material and the FFT
        domain are sized to B at the ceremony; a batch of three cannot be decrypted, so the
        coordinator pads with self-sealed dummies rather than shrinking the math.</p>

        <h3>Shares and public verification</h3>
        <div class="eq">
          <div><span>operator's share</span><code>pd&#11388; = &Sigma;&#7522; &sigma;&#11388;&#7522; &middot; ct&#7522;,&#8320;</code></div>
          <div><span>public check</span><code>e(pd&#11388;, g&#8322;) = &Pi;&#7522; e(ct&#7522;,&#8320;, v&#11388;&#7522;)</code></div>
          <div><span>recovery</span><code>Lagrange-combine any t valid shares at x = 0</code></div>
        </div>
        <p>Operator j runs one multi-scalar multiplication over the frozen headers; the result
        is a single compressed G1 point, 48 bytes, covering the whole batch. The coordinator
        checks each partial against public verification keys before it counts: a forged share
        fails the pairing equation, is recorded as rejected under the operator's identity, and
        never reaches the threshold. Verification needs no secrets, so anyone can re-run it.</p>

        <h3>Pipelined recovery</h3>
        <p>The expensive part of decryption does not wait for operators. The FFT cross-terms
        (<span class="mono">O(B log B)</span> group operations plus
        <span class="mono">O(B)</span> pairings, never the naive <span class="mono">B&sup2;</span>
        loop) depend only on the frozen ciphertexts and the public parameters, so they compute
        at freeze time while shares are still in flight; an integration test asserts pre-decrypt
        finishes before the first share exists. When t verified shares land, finalize is one
        Lagrange interpolation at <span class="mono">x = 0</span> plus the per-slot FO re-check.
        On the public devnet, pre-decrypt runs in roughly 250 ms and finalize in 40 to 150 ms
        for a full 64-slot batch, so the user-visible gap between cue and plaintext is the share
        round-trip, not the math.</p>

        <h3>The commitment</h3>
        <div class="eq">
          <div><span>leaf</span><code>sha256(position_le_u32 || payload)</code></div>
          <div><span>parent</span><code>sha256(left || right), odd node promoted</code></div>
          <div><span>padding payload</span><code>"BTE_DUMMY_V0:" || 16 random bytes</code></div>
        </div>
        <p>The merkle root binds every slot, padding included, so a published reveal cannot be
        edited without detection. Padding slots are real self-sealed ciphertexts with a tagged
        random payload, unique per batch, and operators do identical work on them, so the
        padding is not a shortcut. Anyone can download the batch from the reveal endpoint,
        recompute the root, and compare it with the published or onchain-anchored value.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="ceremony">The ceremony and the keys</h2>
        <p>v0 key generation is a single offline dealer running
        <span class="mono">simple-bte::crs::setup</span>: it samples
        <span class="mono">&tau;</span>, computes the punctured public parameters, Shamir-deals
        the shares of each power to the n operators, writes each share into a
        password-encrypted keystore (argon2id key derivation, ChaCha20-Poly1305 sealing),
        publishes the parameter blob, and destroys <span class="mono">&tau;</span>. The
        parameter set is content-addressed: its SHA-256 digest is the committee id, which is why
        an application can pin one committee and reject every other.</p>
        <p>Operator nodes never hand their keystores to anyone. A node decrypts its keystore
        locally at startup, holds the share in memory, and speaks only outbound HTTP to the
        coordinator. The coordinator cannot reach into a node, and a stolen coordinator database
        contains ciphertexts and public data, not key material.</p>
        <p>The dealer is the v0 compromise, stated plainly: whoever ran the ceremony could have
        kept <span class="mono">&tau;</span> and could decrypt everything early. That is
        acceptable for a devnet and unacceptable for value. The production replacement is a
        distributed key generation in which the trapdoor never exists on any single machine,
        plus proactive resharing so operators can rotate without changing the public key
        applications pinned.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="privacy">Two privacy layers</h2>
        <p><strong>The network proves when. The link decides who.</strong> Threshold reveal is
        deliberately public: after the cue, every slot's plaintext is on the record so anyone
        can verify the batch. That is exactly right for auctions and votes, whose fairness
        depends on every participant reading the same reveal, and wrong for a personal note. So
        a second, purely client-side layer exists on top.</p>
        <div class="eq">
          <div><span>private payload</span><code>"BTEP1" || iv (12 bytes) || AES-128-GCM(key, text)</code></div>
          <div><span>share link</span><code>#/s/&lt;code&gt;/&lt;key&gt;</code></div>
        </div>
        <p>Before sealing, the browser wraps a personal payload in AES-128-GCM. The key never
        reaches any server: it rides only in the share link's hash fragment, which browsers do
        not transmit. The network still proves when the seal opened; only people holding the
        full link learn what it said. The explorer marks such slots private instead of printing
        ciphertext, and a link that lost its key segment gets a clear error rather than garbage.
        The trade is explicit: there is no recovery path. Lose every copy of the link and the
        content stays unreadable, by construction.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="architecture">Architecture</h2>
        <p>The design separates the public edge from secret-bearing operators. The browser and
        explorer are public. The coordinator is a scheduler and aggregator that never sees
        pre-cue plaintext. Operator nodes accept no inbound connections and never expose their
        keystores.</p>

        <figure>
          <svg class="diagram" viewBox="0 0 884 470" role="img" aria-label="Peal architecture: a dapp with the SDK seals in wasm and sends ciphertext through a TLS edge to the coordinator, which persists ciphertexts and reveals in a volume-backed database, optionally anchors the reveal root onchain, and exchanges work and 48-byte shares with five outbound-only operator nodes">
            <rect x="30" y="40" width="200" height="72" rx="12" fill="#dbe7f8" stroke="#1f2937" stroke-width="1.5"/>
            <text x="130" y="71" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">dapp + SDK</text>
            <text x="130" y="93" text-anchor="middle" font-size="12.5" fill="#6b7280">seals in wasm</text>
            <path d="M230 76 L302 76" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M294 70 L304 76 L294 82" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <text x="267" y="62" text-anchor="middle" font-size="11" class="m" fill="#6b7280">ciphertext</text>
            <rect x="306" y="40" width="200" height="72" rx="12" fill="#f1f0ee" stroke="#1f2937" stroke-width="1.5"/>
            <text x="406" y="71" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">TLS edge</text>
            <text x="406" y="93" text-anchor="middle" font-size="12.5" fill="#6b7280">explorer + rate limit</text>
            <path d="M506 76 L578 76" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M570 70 L580 76 L570 82" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <text x="543" y="63" text-anchor="middle" font-size="12" class="m" fill="#6b7280">/v0</text>
            <rect x="582" y="36" width="240" height="80" rx="12" fill="#ffffff" stroke="#2563eb" stroke-width="2"/>
            <text x="702" y="69" text-anchor="middle" font-size="17" font-weight="700" fill="#1f2430">coordinator</text>
            <text x="702" y="92" text-anchor="middle" font-size="12.5" fill="#6b7280">freeze &middot; verify &middot; recover</text>
            <path d="M702 116 L702 160" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M696 152 L702 162 L708 152" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <rect x="582" y="164" width="240" height="66" rx="12" fill="#f1f0ee" stroke="#1f2937" stroke-width="1.5"/>
            <text x="702" y="192" text-anchor="middle" font-size="15" font-weight="700" fill="#1f2430">database + volume</text>
            <text x="702" y="213" text-anchor="middle" font-size="12.5" fill="#6b7280">ciphertexts &middot; reveals</text>
            <path d="M578 197 L474 197" stroke="#1f2937" stroke-width="1.5"/>
            <path d="M482 191 L472 197 L482 203" fill="none" stroke="#1f2937" stroke-width="1.5"/>
            <text x="526" y="184" text-anchor="middle" font-size="12" class="m" fill="#6b7280">root</text>
            <rect x="268" y="164" width="200" height="66" rx="12" fill="#f6eec6" stroke="#1f2937" stroke-width="1.5" stroke-dasharray="6 5"/>
            <text x="368" y="192" text-anchor="middle" font-size="15" font-weight="700" fill="#1f2430">onchain anchor</text>
            <text x="368" y="213" text-anchor="middle" font-size="12.5" fill="#6b7280">optional &middot; reveal root</text>
            <rect x="30" y="292" width="792" height="146" rx="14" fill="none" stroke="#e7e2d9" stroke-width="1.5"/>
            <text x="52" y="322" font-size="13" class="m" fill="#16a34a">the committee &middot; any 3 of 5 reveal</text>
            <g>
              <rect x="52" y="340" width="140" height="72" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.5"/>
              <rect x="206" y="340" width="140" height="72" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.5"/>
              <rect x="360" y="340" width="140" height="72" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.5"/>
              <rect x="514" y="340" width="140" height="72" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.5"/>
              <rect x="668" y="340" width="140" height="72" rx="12" fill="#d9f0dd" stroke="#1f2937" stroke-width="1.5"/>
              <text x="122" y="371" text-anchor="middle" font-size="14.5" font-weight="700" fill="#1f2430">node 1</text>
              <text x="276" y="371" text-anchor="middle" font-size="14.5" font-weight="700" fill="#1f2430">node 2</text>
              <text x="430" y="371" text-anchor="middle" font-size="14.5" font-weight="700" fill="#1f2430">node 3</text>
              <text x="584" y="371" text-anchor="middle" font-size="14.5" font-weight="700" fill="#1f2430">node 4</text>
              <text x="738" y="371" text-anchor="middle" font-size="14.5" font-weight="700" fill="#1f2430">node 5</text>
              <text x="122" y="392" text-anchor="middle" font-size="12" fill="#6b7280">keystore</text>
              <text x="276" y="392" text-anchor="middle" font-size="12" fill="#6b7280">keystore</text>
              <text x="430" y="392" text-anchor="middle" font-size="12" fill="#6b7280">keystore</text>
              <text x="584" y="392" text-anchor="middle" font-size="12" fill="#6b7280">keystore</text>
              <text x="738" y="392" text-anchor="middle" font-size="12" fill="#6b7280">keystore</text>
            </g>
            <path d="M800 336 C862 288, 866 152, 830 88" stroke="#2563eb" stroke-width="1.7" fill="none"/>
            <path d="M822 98 L828 84 L838 94" fill="none" stroke="#2563eb" stroke-width="1.7"/>
            <text x="790" y="252" text-anchor="end" font-size="12.5" class="m" fill="#2563eb">poll work,</text>
            <text x="790" y="270" text-anchor="end" font-size="12.5" class="m" fill="#2563eb">post shares</text>
            <text x="790" y="288" text-anchor="end" font-size="11.5" fill="#6b7280">outbound only</text>
          </svg>
          <figcaption>Operator nodes connect outbound only; the coordinator can never reach into
          a keystore. Any 3 of the 5 shares complete a reveal.</figcaption>
        </figure>

        <div class="tcard">
          <table>
            <thead><tr><th>component</th><th>role</th></tr></thead>
            <tbody>
              <tr><td>bte-sdk</td><td>fetches and digest-checks parameters, seals in wasm, submits ciphertexts, waits for reveals, optionally verifies the anchored root</td></tr>
              <tr><td>bte-coordinator</td><td>condition engine, SQLite state machine, deterministic freeze, pipelined pre-decrypt, pairing checks, REST /v0</td></tr>
              <tr><td>bte-node</td><td>polls outbound for frozen work, decrypts its local argon2id + ChaCha20 keystore, computes one partial, posts it</td></tr>
              <tr><td>BteAnchor.sol</td><td>commits ciphertext hashes to conditions and records the final merkle root from an authorized publisher</td></tr>
            </tbody>
          </table>
        </div>

        <h3>The public API, in one table</h3>
        <div class="tcard">
          <table>
            <thead><tr><th>endpoint</th><th>caller</th><th>purpose</th></tr></thead>
            <tbody>
              <tr><td>GET /v0/committees/:id</td><td>everyone</td><td>public parameters, digest-checked by clients</td></tr>
              <tr><td>POST /v0/conditions</td><td>apps</td><td>create a cue: at a time, in N seconds, or at a block height, with an optional tag</td></tr>
              <tr><td>GET /v0/conditions[/:id]</td><td>everyone</td><td>status, fires_at, counts, tag, per-batch share progress</td></tr>
              <tr><td>POST /v0/ciphertexts</td><td>apps</td><td>submit a sealed blob to a pending condition</td></tr>
              <tr><td>GET /v0/work</td><td>operators</td><td>frozen batches awaiting this operator's share</td></tr>
              <tr><td>POST /v0/shares</td><td>operators</td><td>submit a 48-byte partial; pairing-verified on arrival</td></tr>
              <tr><td>GET /v0/reveals/:id</td><td>everyone</td><td>404 until revealed, then slots, share log, timings, merkle root</td></tr>
            </tbody>
          </table>
        </div>
        <p class="muted" style="font-size:14px">The reveals endpoint returning 404 before the
        cue is itself an invariant with a test behind it: the test greps the coordinator's
        database for plaintext bytes while a condition is pending and must find none.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="byzantine">The byzantine drill</h2>
        <p>The claim that verification catches liars is tested, not asserted. The repo ships a
        drill (<span class="mono">just demo-byzantine</span>) that runs the full sealed-bid
        auction with two failures injected at once: operator 2 runs a byzantine build that
        submits a corrupt share, and operator 5 is killed mid-flow. The recorded outcome,
        verified through the API rather than the demo's own output: operator 2's share arrives,
        fails the pairing equation, and is stored as rejected under its identity; operator 5
        never submits; the reveal completes from the three honest shares. The auction's winner
        is identical to the clean run.</p>
        <p>That is the failure envelope in one sentence: up to <span class="mono">n - t</span>
        operators can lie or die simultaneously, attribution is automatic, and the reveal is
        bit-exact regardless of which honest subset supplied the shares.</p>
      </section>

      <section class="scroll-reveal">
        <h2 id="integration">Building on it</h2>
        <p>The product path is four calls: create a condition, seal locally, store the returned
        hash, wait for the reveal.</p>

        <div class="codecard">
          <span class="lang">typescript</span>
<pre><code><span class="ck">import</span> { BteClient } <span class="ck">from</span> <span class="cs">'bte-sdk'</span>;

<span class="cc">// one client, pointed at the network</span>
<span class="ck">const</span> peal = <span class="ck">new</span> BteClient({ url: <span class="cs">'https://peal.network'</span> });

<span class="cc">// a cue 60 seconds out, tagged so this app finds its own rounds</span>
<span class="ck">const</span> conditionId = <span class="ck">await</span> peal.condition({ <span class="ck">in</span>: 60, tag: <span class="cs">'auction-v1'</span> });

<span class="cc">// seal locally; bind the app context inside the encrypted bytes</span>
<span class="ck">const</span> sealed = <span class="ck">await</span> peal.seal(JSON.stringify({
  app: <span class="cs">'auction-v1'</span>,
  conditionId,                      <span class="cc">// replay binding</span>
  lotId: <span class="cs">'lot-42'</span>,
  bid: 815,
  nonce: crypto.randomUUID()
}), conditionId);

<span class="cc">// the network does the rest; no second transaction exists</span>
<span class="ck">const</span> reveal = <span class="ck">await</span> peal.waitForReveal(conditionId);
<span class="ck">const</span> slot = reveal.slots.find((s) =&gt; s.ctHash === sealed.ctHash);

<span class="ck">if</span> (!slot?.valid) <span class="ck">throw new</span> Error(<span class="cs">'sealed bid did not recover'</span>);
console.log(slot.text);</code></pre>
        </div>

        <ul>
          <li><strong>Pin the committee digest.</strong> Ship the expected public-parameter
          digest with your app; do not silently accept a coordinator-selected committee.</li>
          <li><strong>Bind the payload.</strong> Put the condition id, app domain, action type,
          and a nonce inside the encrypted bytes and validate them after reveal, so a copied
          ciphertext cannot be replayed into a different context undetected.</li>
          <li><strong>Persist the ciphertext hash.</strong> It is the stable handle for the
          commitment. Store it in your database or anchor it onchain before the cue.</li>
          <li><strong>Tag your conditions.</strong> The optional tag (up to 32 characters of
          <span class="mono">a-z 0-9 : _ -</span>) lets your app find its own rounds and never
          join a stranger's. Peal Network's explorer keeps bid rounds, vote rounds, and capsules apart
          this way.</li>
          <li><strong>Treat reveal as asynchronous.</strong> Poll or index; handle pending,
          frozen, stalled, revealed, and per-slot corrupt states explicitly.</li>
          <li><strong>Layer client-side encryption for personal data.</strong> The network
          reveal is public; if only the recipient should read the content, encrypt inside the
          payload and carry the key in your own channel, as private capsules do in the link
          fragment.</li>
        </ul>

        <h3>Failure behavior is explicit</h3>
        <div class="tcard">
          <table>
            <thead><tr><th>failure</th><th>behavior</th></tr></thead>
            <tbody>
              <tr><td>one node offline</td><td>reveal continues with any 3 of 5</td></tr>
              <tr><td>one forged share</td><td>pairing check rejects it; the operator identity stays visible in the log</td></tr>
              <tr><td>one mauled ciphertext</td><td>that slot is marked corrupt; the other 63 recover</td></tr>
              <tr><td>coordinator restart</td><td>state reloads from the database, pre-decrypt recomputes, nodes repoll</td></tr>
              <tr><td>fewer than t shares</td><td>the condition stalls after 120 s; it is never falsely revealed</td></tr>
              <tr><td>late valid share</td><td>a stalled condition completes automatically</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="scroll-reveal">
        <h2 id="numbers">The numbers</h2>
        <p>Measured on the public devnet (n = 5, t = 3, B = 64), not estimated.</p>
        <div class="tcard">
          <table>
            <thead><tr><th>quantity</th><th>value</th><th>note</th></tr></thead>
            <tbody>
              <tr><td>seal overhead</td><td class="mono">64 bytes</td><td>48-byte KEM header + 16-byte key mask</td></tr>
              <tr><td>wire size, short text</td><td class="mono">~110 bytes</td><td>framing adds magic, type, length</td></tr>
              <tr><td>operator share</td><td class="mono">48 bytes</td><td>one compressed G1 point per operator per batch, any fill</td></tr>
              <tr><td>pre-decrypt</td><td class="mono">~250 ms</td><td>pipelined away: runs at freeze, before any share exists</td></tr>
              <tr><td>finalize</td><td class="mono">40 to 150 ms</td><td>user-visible: Lagrange combine + per-slot FO re-check</td></tr>
              <tr><td>engine tick</td><td class="mono">500 ms</td><td>freeze scheduling granularity</td></tr>
              <tr><td>stall timeout</td><td class="mono">120 s</td><td>REVEAL_TIMEOUT_SECS; late shares still complete</td></tr>
              <tr><td>rate limit</td><td class="mono">50 rps, burst 400</td><td>per client IP, token bucket</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="scroll-reveal">
        <h2 id="production">Production posture</h2>
        <p>The current stack runs a transparent public devnet: a real threshold committee,
        public share verification, durable state on a mounted volume, recovery after restart,
        TLS, rate limiting, and honest stall states. The decisive blockers for real value are the
        ceremony and the operator set: both are ours today.</p>
        <div class="tcard">
          <table>
            <thead><tr><th>layer</th><th>v0 today</th><th>production target</th></tr></thead>
            <tbody>
              <tr><td>key generation</td><td>offline trusted dealer</td><td>audited DKG; no machine ever knows the whole trapdoor</td></tr>
              <tr><td>operator lifecycle</td><td>new ceremony to replace one</td><td>proactive resharing and rotation under a stable public key</td></tr>
              <tr><td>availability</td><td>coordinator database + volume</td><td>replicated store plus blob or calldata copies of ciphertexts</td></tr>
              <tr><td>accountability</td><td>invalid shares attributable</td><td>stake, slashing, signed work receipts</td></tr>
              <tr><td>verification</td><td>offchain pairing check, anchored root</td><td>EIP-2537 onchain verification of shares and combination</td></tr>
              <tr><td>operations</td><td>health endpoint, structured logs</td><td>SLOs, metrics, paging, tracing, backups</td></tr>
              <tr><td>security</td><td>unaudited prototype</td><td>independent audits and ceremony review</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="scroll-reveal">
        <h2 id="trust">The trust model, stated precisely</h2>
        <div class="cols">
          <div>
            <h3>You do not trust</h3>
            <ul>
              <li>the coordinator with pre-cue plaintext</li>
              <li>any coalition smaller than the threshold</li>
              <li>an operator's claim that its share is valid</li>
              <li>the explorer's arithmetic; recompute the root yourself</li>
            </ul>
          </div>
          <div>
            <h3>V0 still requires trust</h3>
            <ul>
              <li>the dealer did not retain or leak &tau;</li>
              <li>the five operators do not collude; today they are all ours</li>
              <li>at least t operators answer after the cue</li>
              <li>the coordinator includes every submitted ciphertext</li>
              <li>the deployment preserves ciphertext availability</li>
            </ul>
          </div>
        </div>
        <p class="warning"><strong>v0 is dealer-trusted and unaudited.</strong> Use it for
        testnets, demos, and integration work. DKG and an
        independent audit are prerequisites for a stronger claim.</p>
        <div class="article-links">
          <a class="link" href="https://eprint.iacr.org/2026/760" target="_blank" rel="noopener">the paper</a>
          <a class="link" href="https://github.com/commonwarexyz/simple-bte" target="_blank" rel="noopener">simple-bte</a>
          <a class="link" href="https://github.com/Adityaakr/batched-threshold-encryption" target="_blank" rel="noopener">Peal source</a>
          <a class="link" href="#/app">the live explorer</a>
        </div>
      </section>
    </article>
  `;
}

export function renderProtocol(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal protocol. how guaranteed reveal works';
  root.innerHTML = protocolHtml();

  const cleanupReveal = mountScrollReveal(root);
  const nav = root.querySelector<HTMLElement>('.protocol-nav');
  const buttons = Array.from(nav?.querySelectorAll<HTMLButtonElement>('[data-section]') ?? []);
  const setCurrentSection = (id: string) => {
    for (const button of buttons) {
      if (button.dataset.section === id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  const scrollToSection = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-section]');
    if (!button) return;
    const id = button.dataset.section ?? '';
    const section = document.getElementById(id);
    setCurrentSection(id);
    section?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  nav?.addEventListener('click', scrollToSection);

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      const id = visible[0]?.target.id;
      if (id) setCurrentSection(id);
    },
    { rootMargin: '-10% 0px -76% 0px' },
  );
  for (const [id] of sections) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }

  return () => {
    cleanupReveal();
    nav?.removeEventListener('click', scrollToSection);
    observer.disconnect();
    document.title = previousTitle;
  };
}

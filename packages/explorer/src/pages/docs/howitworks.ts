import type { DocsPage } from '../../docs';

export const howItWorks: DocsPage = {
  title: 'How it works',
  lede: 'Three pieces, and which one does what, because somebody deciding whether to build on this needs the mechanism rather than the pitch.',
  html: `
<h2>How it works</h2>
        <p>Your app encrypts locally with batched threshold encryption (BTE) and sends a
        ciphertext. The coordinator stores it and holds no key that opens it. When the moment
        arrives, three of the five operators each publish a decryption share, the whole batch
        opens at once, and everyone reads the same result.</p>

        <figure class="dev-figure">
          <svg viewBox="0 0 920 352" role="img" class="sketch"
               aria-label="Your app encrypts a payload locally and sends only ciphertext to the coordinator, which stores it unreadable until the condition fires, when three of five operators open the whole batch at once for everyone.">
            <defs>
              <marker id="dv-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0.5 1 L9 5 L0.5 9" fill="none" stroke="currentColor"
                      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </marker>
            </defs>

            <!-- 1. your app -->
            <g class="sk-node">
              <path class="sk-box sk-box-you"
                    d="M18 46 q -2 -12 10 -13 l 200 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -201 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="42" y="78">your app or agent</text>
              <text class="sk-line" x="42" y="104">bid, vote, quote, forecast</text>
              <text class="sk-strong" x="42" y="130">encrypted here</text>
              <text class="sk-line" x="42" y="152">plaintext never leaves</text>
            </g>

            <!-- 2. coordinator -->
            <g class="sk-node">
              <path class="sk-box"
                    d="M348 46 q -2 -12 10 -13 l 218 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -219 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="372" y="78">coordinator</text>
              <text class="sk-line" x="372" y="104">holds ciphertexts only</text>
              <text class="sk-line" x="372" y="126">no key that opens one</text>
              <text class="sk-line" x="372" y="152">batch of 64, padded with decoys</text>
            </g>

            <!-- 3. committee -->
            <g class="sk-node">
              <path class="sk-box"
                    d="M700 46 q -2 -12 10 -13 l 190 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -191 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="724" y="78">5 operators</text>
              <text class="sk-line" x="724" y="104">any 3 can open</text>
              <text class="sk-line" x="724" y="126">any 2 cannot</text>
              <g class="sk-dots">
                <circle cx="732" cy="150" r="7" class="sk-on" />
                <circle cx="754" cy="150" r="7" class="sk-on" />
                <circle cx="776" cy="150" r="7" class="sk-on" />
                <circle cx="798" cy="150" r="7" />
                <circle cx="820" cy="150" r="7" />
              </g>
            </g>

            <!-- arrows across the top row -->
            <path class="sk-arrow" marker-end="url(#dv-arrow)" d="M244 108 q 44 -8 96 0" />
            <text class="sk-tag" x="252" y="94">ciphertext</text>
            <path class="sk-arrow" marker-end="url(#dv-arrow)" d="M596 108 q 46 -8 96 0" />
            <text class="sk-tag" x="604" y="94">shares</text>

            <!-- Everything from sealing until the cue is unreadable. Labelled to
                 the left of the drop line so nothing crosses the words. -->
            <path class="sk-brace" d="M40 206 q 200 12 384 2" />
            <text class="sk-tag sk-end" x="424" y="232">unreadable by anyone, including us</text>

            <!-- the condition, underneath -->
            <path class="sk-arrow sk-dash" d="M469 178 L469 214" marker-end="url(#dv-arrow)" />
            <g class="sk-node">
              <path class="sk-box sk-box-cue"
                    d="M334 264 q -2 -12 10 -13 l 250 -2 q 12 0 12.5 11 l 1 58 q 0 12 -11 12.5 l -251 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="358" y="298">the condition fires</text>
              <text class="sk-line" x="358" y="320">a time, or a block height</text>
            </g>

            <!-- reveal -->
            <path class="sk-arrow" d="M614 290 L710 290" marker-end="url(#dv-arrow)" />
            <g class="sk-node">
              <path class="sk-box sk-box-open"
                    d="M716 256 q -2 -12 10 -13 l 174 -2 q 12 0 12.5 11 l 1 74 q 0 12 -11 12.5 l -175 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="740" y="290">everything opens</text>
              <text class="sk-line" x="740" y="312">at once, for everyone</text>
              <text class="sk-line" x="740" y="332">merkle root over the set</text>
            </g>
          </svg>
          <figcaption>Encryption happens in your process. Nothing between it and the deadline can
          read the payload, and opening it takes three operators acting together.</figcaption>
        </figure>

        <div class="dev-life">
          <div class="dev-life-step is-now">
            <span class="dev-pill dev-pill-open">open</span>
            <p>Anyone can seal. Nothing is readable, including the count of what is inside.</p>
          </div>
          <div class="dev-life-step">
            <span class="dev-pill dev-pill-closing">closing</span>
            <p>The deadline passed. The batch is frozen and padded; operators are producing
            shares.</p>
          </div>
          <div class="dev-life-step">
            <span class="dev-pill dev-pill-opened">opened</span>
            <p>Every payload is public in the same instant, with a merkle root over the set.</p>
          </div>
        </div>

        <p>A round can also say what it is, so somebody deciding whether to take part can see it
        before anything opens. That part is public from the moment the round exists, which is
        exactly the opposite of the payloads sealed to it:</p>

        <div class="dev-roundcard">
          <div class="dev-roundcard-img" aria-hidden="true">
            <svg viewBox="0 0 120 96"><rect width="120" height="96" rx="8" />
              <path d="M14 74 L44 40 L66 62 L84 48 L106 74 Z" class="dev-roundcard-hill" />
              <circle cx="88" cy="28" r="9" class="dev-roundcard-sun" />
            </svg>
            <span>image_url</span>
          </div>
          <div class="dev-roundcard-body">
            <p class="dev-roundcard-title">Signed tour poster <span class="dev-pill dev-pill-open">open</span></p>
            <p class="dev-roundcard-desc">One of a kind, ships worldwide.</p>
            <p class="dev-roundcard-meta"><code>opens_at</code> 2026-09-12T18:00:00Z ·
            <code>seals</code> 14 · <code>tag</code> my-app</p>
          </div>
        </div>

        <p>Three details worth knowing. <strong>How many sealed is not published while a round is
        open.</strong> <code>seals</code> and <code>slots_including_decoys</code> come back
        <code>null</code> until it opens, and the list of seal ids with them, because a live count
        is the number a competitor in a sealed auction most wants and the deadline is exactly when
        it is worth something. You read your own back with
        <code>GET /v1/seals/{id}</code>, using the id your own submission returned.</p>

        <p>Then every batch is padded to 64 with decoys the coordinator seals to itself, so once a
        round has opened, a round with three submissions still does not announce that it had three;
        decoys come back flagged <code>is_dummy</code>. And slot positions are derived from the
        ciphertext hashes rather than arrival order, so a batch cannot be reordered after the
        fact.</p>`,
};

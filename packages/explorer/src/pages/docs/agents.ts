/** The agent skill: install once, then ask for what you want. */
import type { DocsPage } from '../../docs';
import { shown } from './runner';
import { esc } from '../../util';

export const agents: DocsPage = {
  title: 'Use it from a coding agent',
  lede: 'Install one skill and your agent can add Peal to an application without reading any of this first.',
  html: `
    <h2 id="install">Install</h2>
    <p>Ten markdown files into <code>.claude/skills/peal/</code> in your project. No package, no
    registry, no account.</p>
    <pre class="doc-code"><code>curl -fsSL ${esc(shown)}/skill/install.sh | sh</code></pre>
    <p>Then ask for what you want, in your own words:</p>
    <pre class="doc-code"><code>use the peal skill to add sealed bid auctions to my marketplace
for the vintage camera listing, closing Monday at 6pm, reserve $50</code></pre>

    <h2 id="what-it-does">What it does with that</h2>
    <p>The skill is a procedure, not a reference card. Given a sentence like the one above, the
    agent works through five steps, and the order matters because the shape of the integration
    depends on what is already in your codebase.</p>

    <ol class="doc-list">
      <li><strong>Surveys your application first.</strong> Whether there is a server or only a
      front end, where listings live, how state is stored, where the buy button is, and how you
      already handle time. It tells you what it found before it writes anything.</li>
      <li><strong>Pins the deadline.</strong> "Monday at 6pm" becomes an exact instant in your
      timezone, confirmed back to you in full before anything is created, because an auction that
      closes at the wrong hour cannot be undone.</li>
      <li><strong>Chooses where the code runs.</strong> Bids are sealed in the browser, because a
      plaintext bid must never reach a server, including yours. Your server creates the auction
      and reads results.</li>
      <li><strong>Writes it against your stack</strong>, from tested integrations for Next.js,
      Express, a static page, or a non-JavaScript backend.</li>
      <li><strong>Verifies before reporting success.</strong> It runs a script that opens a real
      auction with a short deadline, bids on it, waits for it to open and checks the board. About
      ninety seconds, and it exercises the whole path.</li>
    </ol>

    <p class="dev-note">More examples that work: <em>"collect quotes from my suppliers privately
    until Friday"</em> · <em>"let people vote on this without seeing a running tally"</em> ·
    <em>"my agents keep front running each other, seal their actions until the round ends"</em>.</p>

    <p class="dev-note">If piping a script to a shell is not something you do, read
    <a href="${esc(shown)}/skill/install.sh" target="_blank" rel="noopener">install.sh</a> first.
    It is four <code>curl</code> commands and a <code>mkdir</code>; it writes nothing else and runs
    nothing else. Or copy the files yourself from
    <a href="${esc(shown)}/skill/SKILL.md" target="_blank" rel="noopener">/skill/SKILL.md</a>.</p>

    <h2 id="why-a-skill">Why a skill rather than documentation</h2>
    <p>An agent that has read a reference page can call the endpoints. That is not the hard part.
    The hard part is the handful of decisions that produce code which looks right and is wrong,
    and which no endpoint description would warn anybody about:</p>
    <ul class="doc-list">
      <li>Money as a float instead of integer minor units, which is fine until an auction is
      large enough for the rounding to matter and there is no arguing with a number that came out
      wrong in public.</li>
      <li>Sealing the digits of a bid without padding, which puts its magnitude on the wire. The
      ciphertext length ranks the whole auction for anyone watching, before a single bid
      opens.</li>
      <li>Sending the seller's private contact key to the server, which would let us read every
      contact detail the scheme exists to protect.</li>
      <li>Treating a slot count as a participant count, when batches are padded with decoys
      precisely so they are not the same number.</li>
      <li>Handling the null that every v1 read returns before the deadline as an error, or as an
      empty result, when it is the guarantee working.</li>
    </ul>
    <p>The skill leads with those, because an agent that gets them right the first time is the
    whole point of installing it.</p>

    <h2 id="whats-inside">What is inside</h2>
    <ul class="doc-list">
      <li><strong>SKILL.md</strong>: the procedure above, the mistakes that produce code which
      looks right and is wrong, and the trust model stated plainly enough that an agent will not
      overclaim it to a user.</li>
      <li><strong>reference/recipes.md</strong>: working integrations for Next.js, Express, a
      static page and a non-JavaScript backend, including the one that catches everybody: a URL
      import of the client works in a browser and throws in Node.</li>
      <li><strong>reference/time.md</strong>: turning "Monday at 6pm" into an exact instant, with
      a timezone helper checked against daylight saving, a 45 minute offset and a negative
      one.</li>
      <li><strong>reference/verify.md</strong>: the end to end script, and what each failure
      means when it does not pass.</li>
      <li><strong>reference/api.md</strong>: every endpoint, its parameters and its responses.</li>
      <li><strong>reference/auctions.md</strong>: the money rules, contact details and the check
      code.</li>
      <li><strong>reference/errors.md</strong>: every error code and every limit, as tables.</li>
      <li><strong>reference/ui.md</strong>: matching the app's design system, and the states an
      interface for sealed submissions needs.</li>
      <li><strong>reference/payments.md</strong>: charging per call with x402, and copying the
      pattern into your own API.</li>
      <li><strong>reference/links.md</strong>: Peal Private Links: private payment links and
      transfers through the SDK and the <code>/links/v1</code> API, with the trust model an agent
      must not overstate.</li>
    </ul>

    <h2 id="other-tools">Other tools</h2>
    <p>The files are plain markdown with YAML frontmatter, which is the Claude Code skill format.
    Anything that reads a project instruction file can use the same content: point it at
    <code>.claude/skills/peal/SKILL.md</code>, or paste it.</p>
    <p>For a model with web access and no skill installed,
    <a href="${esc(shown)}/llms.txt" target="_blank" rel="noopener">llms.txt</a> is the short
    version, written to be quoted.</p>
    <p>An MCP server is on <a href="#/developers/roadmap">the roadmap</a>, which is the other way
    an agent could reach this without any files at all.</p>`,
};

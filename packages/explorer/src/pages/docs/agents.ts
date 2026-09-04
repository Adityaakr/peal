/** The agent skill: install once, then ask for what you want. */
import type { DocsPage } from '../../docs';
import { shown } from './runner';
import { esc } from '../../util';

export const agents: DocsPage = {
  title: 'Use it from a coding agent',
  lede: 'Install one skill and your agent can add Peal to an application without reading any of this first.',
  html: `
    <h2 id="install">Install</h2>
    <p>Four markdown files into <code>.claude/skills/peal/</code> in your project. No package, no
    registry, no account.</p>
    <pre class="doc-code"><code>curl -fsSL ${esc(shown)}/skill/install.sh | sh</code></pre>
    <p>Then ask for what you want:</p>
    <pre class="doc-code"><code>add a sealed bid auction to this app using peal</code></pre>

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
      <li>Handling a 404 before the deadline as an error, when it is the guarantee working.</li>
    </ul>
    <p>The skill leads with those, because an agent that gets them right the first time is the
    whole point of installing it.</p>

    <h2 id="whats-inside">What is inside</h2>
    <ul class="doc-list">
      <li><strong>SKILL.md</strong> — the mental model, the three calls, auctions, the mistakes to
      avoid, and the trust model stated plainly enough that an agent will not overclaim it to a
      user.</li>
      <li><strong>reference/api.md</strong> — every endpoint, its parameters and its responses.</li>
      <li><strong>reference/auctions.md</strong> — the money rules, contact details, the check
      code, and a checklist before shipping.</li>
      <li><strong>reference/errors.md</strong> — every error code and every limit, as tables.</li>
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

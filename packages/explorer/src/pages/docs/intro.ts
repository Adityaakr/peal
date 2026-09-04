/** The first page anybody lands on. */
import type { DocsPage } from '../../docs';
import { shown } from './runner';
import { esc } from '../../util';

export const intro: DocsPage = {
  title: 'The programmable confidentiality layer for digital markets.',
  lede: 'One API to collect encrypted bids, offers, votes, commitments and agent intents, then reveal them only when predefined conditions are met.',
  html: `
    <h2 id="what-peal-is">What Peal is</h2>
    <p>Everything arrives sealed. Nothing is readable before the deadline, not by the other
    participants, not by you, not by us. When the moment comes the whole set opens at once.</p>

    <blockquote class="doc-quote">If your product has a deadline, it probably has this bug.
    Anywhere people submit something that others must not see yet, whoever runs the server can
    see it. You can promise you do not look. You cannot prove it, and your users cannot
    check.</blockquote>

    <p>That single fact is why sealed bids get run over email, why fair launches get front run,
    and why every commit and reveal scheme leaks a way for the loser to simply never reveal.</p>

    <h2 id="what-is-hard-about-it">What is actually hard about it</h2>
    <p>The encryption was never the hard part. It is that somebody has to hold the key until the
    deadline, and whoever holds it can peek, leak, or quietly decline to open it when the answer
    does not suit them.</p>
    <p>Peal removes that person. No single party can open a batch early, and nobody has to come
    back to reveal, because the network does it on its own when the moment arrives.</p>

    <h2 id="what-you-add">What you add</h2>
    <p>Three HTTP calls. No signup, no API key, no wallet and no gas for the people submitting.
    The client is one file served from this domain, so there is nothing to install and no package
    to trust.</p>

    <pre class="doc-code"><code>import { peal } from '${esc(shown)}/peal.js';

const { id } = await peal.createRound({ opens_in: 3600, tag: 'my-app' });
await peal.seal(userSubmission, id);    // sealed from here on
const payloads = await peal.getPayloads(id);  // all of them, at the close</code></pre>

    <h2 id="where-to-go-next">Where to go next</h2>
    <ul class="doc-list">
      <li><a href="#/developers/quickstart">Quickstart</a> runs the three calls against the live
      network from the page, so you can see it work before writing anything.</li>
      <li><a href="#/developers/howitworks">How it works</a> is the mechanism: what the cue is,
      where the encryption happens, and what you can check afterwards.</li>
      <li><a href="#/developers/auctions">Sealed bid auctions</a> is the thing most people build
      first, and it is a few calls rather than a project.</li>
      <li><a href="#/developers/api">API reference</a> has every endpoint, the error codes and
      the rate limits.</li>
    </ul>`,
};

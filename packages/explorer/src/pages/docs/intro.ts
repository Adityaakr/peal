/** The first page anybody lands on. */
import type { DocsPage } from '../../docs';
import { shown } from './runner';
import { esc } from '../../util';

export const intro: DocsPage = {
  title: 'The privacy layer for onchain markets.',
  lede: 'One API to collect encrypted bids, offers, votes, commitments and agent intents, then reveal them only when predefined conditions are met.',
  html: `
    <h2 id="what-peal-is">What Peal is</h2>
    <p>Peal is the privacy layer for onchain markets. Bids, offers,
    votes, commitments and agent intents arrive encrypted and remain unreadable until a
    predefined condition is met. When that moment arrives, the entire set is revealed
    together. The primitive underneath every one of those is batched threshold encryption
    (BTE): a payload is encrypted on the client to a committee, and only a threshold of its
    operators, acting after the condition fires, can open the batch.</p>

    <blockquote class="doc-quote">Most products with a submission deadline have a hidden trust
    problem: the operator can see what participants submit before everyone else. They can promise
    not to look, but participants have no way to verify that promise.</blockquote>

    <p>This information asymmetry enables front running, selective disclosure and unfair price
    discovery. Traditional commit and reveal systems only move the problem: participants must
    return to reveal, allowing losing bidders to disappear strategically. Peal makes disclosure
    automatic and coordinated, without giving any single participant or operator early
    access.</p>

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

const { id } = await peal.createRound({ opensIn: 3600, tag: 'my-app' });
await peal.seal(userSubmission, id);      // sealed from here on

await peal.waitForOpen(id);               // returns when the deadline passes
const payloads = await peal.getPayloads(id);   // all of them, at once</code></pre>

    <p class="dev-note">Two things this snippet is careful about. The options are camelCase
    (<code>opensIn</code>), while the HTTP body is snake_case (<code>opens_in</code>); passing the
    wrong one now throws rather than being ignored. And <code>getPayloads</code> reads whatever is
    readable right now, which before the deadline is nothing, so
    <code>waitForOpen</code> is what turns it into "at the close".</p>

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
      <li><a href="#/developers/links">Peal Private Links</a> is the other engine: private
      payments on a zero-knowledge ledger, with an <a href="#/developers/links-sdk">SDK</a> and an
      <a href="#/developers/links-api">API</a> of its own.</li>
    </ul>`,
};

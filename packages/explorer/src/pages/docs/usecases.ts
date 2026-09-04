import type { DocsPage } from '../../docs';

export const useCases: DocsPage = {
  title: 'What to build',
  lede: 'People commit to something they cannot take back, and nobody sees anyone else’s until they all open together. That turns out to be the missing piece in a lot of things.',
  html: `
<h2>What to build</h2>
        <p>The shape is always the same: people commit to something they cannot take back, and
        nobody can see anyone else's until they all open together. That turns out to be the missing
        piece in a lot of things.</p>

        <div class="dev-headline">
          <p class="dev-headline-kicker">the one we most want built</p>
          <h3>Sealed actions for autonomous agents, paid per call</h3>
          <p><strong>A pay-per-use API that lets agents seal an action, bid, prediction or message
          until a deadline, then automatically reveal it with cryptographic proof.</strong></p>
          <p>Agents are the users who need this most and can integrate it fastest. An agent that
          submits in the clear can be read and front run by the next agent in the queue. An agent
          cannot sign up for your service, accept terms, or hold an API key it did not earn, but it
          can pay for one request. So the natural shape is a single priced call: seal this until
          then, and prove afterwards that nobody could have touched it.</p>
          <p>Peal supplies the part nobody can build for themselves, which is the evidence that no
          one could peek, copy, alter or open early. <a href="https://docs.x402.org/introduction"
          target="_blank" rel="noopener">x402</a> supplies payment and discovery without an
          account. <a href="#/developers/roadmap">The API shape and pricing are on the roadmap</a>. The primitive they are built on is live and running
          the examples on this page today.</p>
        </div>

        <div class="dev-uses">
          <div class="dev-use">
            <h3>Sealed bid auctions</h3>
            <p>Everyone bids blind, all bids open at the close. Nobody can watch the leader and
            top it by a dollar in the last second, because there is nothing to watch.</p>
            <p class="dev-use-how"><code>tag: 'auction:&lt;id&gt;'</code> · one condition per
            auction, one seal per bid</p>
          </div>
          <div class="dev-use">
            <h3>Encrypted mempools</h3>
            <p>Transactions seal to the block they belong in, so a searcher cannot read the queue
            and jump it. The whole block's worth opens at once when the block is due.</p>
            <p class="dev-use-how"><code>kind: 'at_block'</code> · a condition per block height</p>
          </div>
          <div class="dev-use">
            <h3>Commit and reveal, without the reveal</h3>
            <p>Every commit-reveal game has the same bug: whoever moves last can just not reveal
            when they see they have lost. Here the reveal is not their move to make.</p>
            <p class="dev-use-how"><code>tag: 'game:&lt;round&gt;'</code> · a condition per round</p>
          </div>
          <div class="dev-use">
            <h3>Votes that cannot be swayed</h3>
            <p>No running tally means no bandwagon and no strategic vote cast off the back of one.
            Early voters do not influence late ones because there is nothing to see.</p>
            <p class="dev-use-how"><code>tag: 'vote:&lt;proposal&gt;'</code> · one condition per poll</p>
          </div>
          <div class="dev-use">
            <h3>Agent bids and actions</h3>
            <p>An autonomous agent that submits in the clear can be front-run by another agent
            reading the same queue. Sealing the action means a machine can commit to something it
            cannot secretly alter, and cannot reveal early to gain an edge.</p>
            <p class="dev-use-how"><code>tag: 'agent:&lt;swarm&gt;'</code> · one condition per round</p>
          </div>
          <div class="dev-use">
            <h3>Procurement and quotes</h3>
            <p>Suppliers quote blind. Nobody undercuts a number they were not supposed to see, and
            the buyer cannot shop one supplier's price to another before the close.</p>
            <p class="dev-use-how"><code>tag: 'rfq:&lt;tender&gt;'</code> · quotes as payloads</p>
          </div>
          <div class="dev-use">
            <h3>Prediction tournaments</h3>
            <p>Every forecast is sealed until the window shuts, so nobody copies a better
            forecaster and nobody edits after the fact. The scoreboard is computable by anyone from
            the reveal.</p>
            <p class="dev-use-how"><code>tag: 'round:&lt;n&gt;'</code> · one condition per window</p>
          </div>
          <div class="dev-use">
            <h3>Bounty and grant submissions</h3>
            <p>Entries open together at the deadline, so a late entrant cannot read the field and
            beat it by a nose, and a reviewer cannot leak one entry to another team.</p>
            <p class="dev-use-how"><code>fires_at</code> · the deadline, as a unix second</p>
          </div>
          <div class="dev-use">
            <h3>Token allocations and fair launches</h3>
            <p>A private order book that opens all at once and clears at one price. No visible
            order flow to trade against, and no allocator advantage from seeing the book first.</p>
            <p class="dev-use-how"><code>tag: 'sale:&lt;id&gt;'</code> · orders as payloads</p>
          </div>
          <div class="dev-use">
            <h3>Embargoes that hold themselves</h3>
            <p>Earnings, a security disclosure, a paper under embargo. Distribute it now in a form
            nobody can open early, and it publishes itself on the hour.</p>
            <p class="dev-use-how"><code>fires_at</code> · an absolute unix second</p>
          </div>
          <div class="dev-use">
            <h3>Anything with a deadline</h3>
            <p>Exam papers, a dead man's switch, a scheduled disclosure, a time capsule. If the rule
            is "not before this moment, and then everybody at once", it fits.</p>
            <p class="dev-use-how"><code>in_secs</code> · relative, for anything short lived</p>
          </div>
        </div>`,
};

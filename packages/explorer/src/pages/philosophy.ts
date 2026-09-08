// The philosophy page: the manifesto behind Peal, as a quiet editorial page.
// Josefin Sans (light weights) for headings, DM Sans for body. Sections blur
// in smoothly as they scroll into view; reveals are skipped entirely under
// prefers-reduced-motion. Copy is user-authored; keep it verbatim.
import { mountScrollReveal } from '../reveal';
const tenets = [
  {
    title: 'Secrecy is a state. Disclosure is an event.',
    body: `Fifty years ago, cryptography made hiding programmable. Anyone can encrypt
    anything, forever, for free. But revealing, the other half of every secret worth
    keeping, never got its primitive. Every bid, vote, verdict, and embargo still depends
    on someone choosing to show up and tell the truth at the right moment. Peal exists to
    finish the sentence: encryption made hiding programmable. Peal makes disclosure
    programmable.`,
  },
  {
    title: 'Fairness is simultaneity.',
    body: `Almost everything unfair onchain is a timing problem wearing a disguise. The
    sniper bids last. The bot reads your order first. The whale waits for your hand before
    showing theirs. The fix is not more hiding, it is synchronized showing: when everyone
    learns everything at the same instant, moving last stops being a strategy. A peal of
    bells is the oldest technology humans have for this. Everyone hears it at once.`,
  },
  {
    title: 'A reveal you can skip is not a reveal.',
    body: `Today, anything worth hiding onchain runs on commit-reveal, and commit-reveal
    made honesty optional: users must return for a second transaction, losers quietly
    never reveal, and whoever moves last learns the most. Any system where disclosure is a
    favor will be gamed by exactly the people it was built to constrain. On Peal, reveals
    are not promised, they are inevitable: the construction makes non-reveal impossible,
    so no one has to be trusted to keep their word.`,
  },
  {
    title: 'Everything sealed here opens. That is the product, not the caveat.',
    body: `Peal is not a vault. If you need something hidden forever, we are proudly the
    wrong tool. Everything sealed becomes an open secret: on schedule, in public, all at
    once. We filter for people who want the truth to come out, and we say so on the front
    page.`,
  },
  {
    title: 'No one holds the key. Not even us.',
    body: `Bids, votes, moves, and intents are sealed once to a threshold committee that
    no single operator controls. When the deadline or condition fires, the entire batch
    opens at the same instant, every operator's share verified in public, every reveal on
    the record. A reveal guaranteed by a company is a promise; a reveal guaranteed by a
    construction is a property. The explorer exists so you never have to take our word
    for anything.`,
  },
  {
    title: 'Disclosure is older than computers.',
    body: `Sealed verdicts read in open court. Earnings released at the bell. Embargoes
    lifted at midnight. Time capsules cracked on the hundredth year. Civilization already
    runs on scheduled revelation; it has just never had infrastructure. Peal is a very old
    institution, finally given a primitive.`,
  },
];

/** The page as a string, with nothing touched in the document. Rendered into
 * the document by `renderPhilosophy` and into a static file by src/prerender.ts, so a
 * reader with no JavaScript gets the same words a browser does. */
export function philosophyHtml(): string {
  return `
    <article class="philosophy">
      <header class="philosophy-header scroll-reveal">
        <p class="philosophy-kicker">The Peal philosophy</p>
        <h1 class="philosophy-headline">Peal Network is programmable disclosure:
        encryption that opens on schedule, guaranteed.</h1>
      </header>

      ${tenets
        .map(
          (tenet, index) => `
      <section class="philosophy-tenet scroll-reveal">
        <span class="philosophy-num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <div class="philosophy-tenet-inner">
          <h2 class="philosophy-tenet-title">${tenet.title}</h2>
          <p class="philosophy-body">${tenet.body}</p>
        </div>
      </section>`,
        )
        .join('')}

      <section class="philosophy-unlocks scroll-reveal">
        <h2 class="philosophy-tenet-title">What this unlocks</h2>
        <p class="philosophy-body">Sealed-bid auctions that clear fairly, because no bid
        is readable before close. Games with real hidden state, because moves stay sealed
        until they resolve. Orderflow that cannot be front-run, because nothing leaks
        before ordering locks. Agent track records that cannot be faked, because losers
        reveal alongside winners. All of it built on batched threshold encryption, and all
        of it usable in ten lines of TypeScript.</p>
      </section>

      <footer class="philosophy-close scroll-reveal">
        <p class="philosophy-signoff">Seal now. Reveal on cue.</p>
        <div class="philosophy-links">
          <a class="link" href="#/protocol">How it works</a>
          <a class="link" href="#/app">The live explorer</a>
        </div>
      </footer>
    </article>
  `;
}

export function renderPhilosophy(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'The Peal philosophy. Programmable disclosure';
  root.innerHTML = philosophyHtml();

  const cleanupReveal = mountScrollReveal(root);

  return () => {
    cleanupReveal();
    document.title = previousTitle;
  };
}

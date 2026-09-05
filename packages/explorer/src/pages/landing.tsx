// The landing page (#/): a React island that replaces the old vanilla-TS hero.
//
// It is mounted by main.ts's router via renderLanding(root) and unmounted on
// the next hash change. Design: a full-bleed hero video with a frosted pill
// navbar, the "Secrets that Open Themselves" display headline, and the Peal
// pitch. Nokia-font messages type themselves onto the phone in the video.
//
// Content is Peal's own — only the structure/motion follow the supplied spec.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motion } from 'motion/react';
import './landing.css';

const EASE = [0.16, 1, 0.3, 1] as const;

// Nav links point at real explorer routes; clicking one changes the hash and
// main.ts unmounts this island before rendering the target page.
const NAV_LINKS = [
  { label: 'Philosophy', href: '#/philosophy' },
  { label: 'Explorer', href: '#/app' },
  { label: 'Mempool', href: '#/mempool' },
];

// A short three-beat exchange that reads as a sealed message opening on cue.
const MESSAGES = ['Is it sealed?', 'Sealed.', 'Opens on cue.'];
const TYPING_MS = 100;
const DELETING_MS = 50;
const PAUSE_MS = 2000;

function TypingMessages() {
  const [text, setText] = useState('');
  const [index, setIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const current = MESSAGES[index];

    if (!deleting && text === current) {
      const pause = setTimeout(() => setDeleting(true), PAUSE_MS);
      return () => clearTimeout(pause);
    }

    if (deleting && text === '') {
      setDeleting(false);
      setIndex((i) => (i + 1) % MESSAGES.length);
      return;
    }

    const tick = setTimeout(
      () => {
        setText((t) =>
          deleting ? current.slice(0, t.length - 1) : current.slice(0, t.length + 1),
        );
      },
      deleting ? DELETING_MS : TYPING_MS,
    );
    return () => clearTimeout(tick);
  }, [text, deleting, index]);

  return (
    <div className="absolute left-[48.5%] md:left-[47.5%] lg:left-[48.5%] -translate-x-1/2 bottom-[32%] z-30 w-[110px] sm:w-[130px] flex justify-start text-left">
      <span className="font-nokia text-[#2A3616] text-[10px] sm:text-[14px] leading-tight break-words min-h-[1.5em]">
        {text}
        <motion.span
          className="inline-block w-1.5 h-3 bg-[#2A3616] ml-1 align-middle"
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
        />
      </span>
    </div>
  );
}

function Navbar() {
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 w-[95%] max-w-5xl z-50 pointer-events-none">
      <nav className="pointer-events-auto flex items-center justify-between rounded-full border border-black/10 bg-transparent backdrop-blur-md pl-6 pr-2 py-2">
        <a href="#/" className="flex items-center gap-2">
          <img className="landing-nav-logo" src="/peal-logo.png" alt="" width={36} height={36} />
          <span className="font-instrument text-[28px] tracking-tight text-[#1a1a1a] leading-none">
            Peal
          </span>
        </a>

        <div className="hidden md:flex items-center gap-10">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-sans text-[14px] text-[#1a1a1a] transition-opacity hover:opacity-60"
            >
              {link.label}
            </a>
          ))}
        </div>

        <a
          href="#/app"
          className="group relative overflow-hidden rounded-full bg-[#0871E7] px-5 py-2.5 font-sans text-[14px] text-white shadow-[inset_0_-4px_4px_rgba(255,255,255,0.39)] outline-1 outline-[#0871E7] -outline-offset-1"
        >
          <span
            aria-hidden
            className="absolute left-[10%] top-[1px] h-4 w-[80%] rounded-[12px] bg-gradient-to-b from-[#DEF0FC] to-transparent transition-transform duration-300 group-hover:scale-x-105"
          />
          <span className="relative">Launch App</span>
        </a>
      </nav>
    </div>
  );
}

function ProductHuntBadge() {
  return (
    <a
      className="product-hunt-badge"
      href="https://www.producthunt.com/products/peal-network?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-peal-network"
      target="_blank"
      rel="noopener noreferrer"
    >
      <img
        src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1212832&theme=light&t=1785731867952"
        alt="Peal Network - secrets that open themselves | Product Hunt"
        width={250}
        height={54}
      />
    </a>
  );
}

function Hero() {
  return (
    <section className="relative min-h-screen bg-[#F3F4ED] pt-24 md:pt-32 flex flex-col items-center overflow-hidden">
      <video
        className="absolute inset-0 z-0 h-full w-full object-cover"
        autoPlay
        loop
        muted
        playsInline
        src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260427_054418_a6d194f0-ac86-4df9-abe5-ded73e596d7c.mp4"
      />
      <div className="absolute inset-0 z-10 bg-white/5" />

      <TypingMessages />

      <div className="relative z-20 pointer-events-none px-6 text-center">
        {/* The h1, not a div. This page had no heading of any level, which on the
            one URL every inbound link points at is the cheapest thing to get
            wrong and the cheapest to fix. */}
        <motion.h1
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.5, ease: EASE }}
          className="font-instrument text-[38px] md:text-[56px] lg:text-[72px] leading-[0.85] tracking-tight text-[#1a1a1a] mb-6"
        >
          Secrets that
          <br />
          Open Themselves
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 0.2, ease: EASE }}
          className="product-hunt-badge-row flex justify-center"
        >
          <ProductHuntBadge />
        </motion.div>

      </div>
    </section>
  );
}


// ---------------------------------------------------------------- sections --
//
// Everything below the hero. Written to answer the questions a first time
// visitor actually has, in the order they have them, and deliberately not to
// repeat what /developers already covers: the two pages competing for the same
// words is how a site outranks itself.

/** A heading and its paragraphs, on the shared measure. */
function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="peal-sec">
      <div className="peal-sec-inner">
        <motion.p
          className="peal-eyebrow"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          {eyebrow}
        </motion.p>
        <motion.h2
          className="peal-h2"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, delay: 0.05, ease: EASE }}
        >
          {title}
        </motion.h2>
        <motion.div
          className="peal-prose"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
        >
          {children}
        </motion.div>
      </div>
    </section>
  );
}

/**
 * The problem, drawn.
 *
 * Four submissions land in an open queue and every one of them is legible to
 * everybody, including the last to arrive, who can read the others before
 * deciding. Depth comes from translateZ under a perspective and from nothing
 * else, so the cards stay square to the pixel grid and the type on them stays
 * flat and readable.
 */
function OpenQueueScene() {
  const cards = [
    { v: '$4,200', who: 'first to arrive', last: false },
    { v: '$4,650', who: 'second', last: false },
    { v: '$4,400', who: 'third', last: false },
    { v: '$4,651', who: 'arrives last, having read the rest', last: true },
  ];
  return (
    <motion.div
      className="peal-scene peal-scene-open"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.8, ease: EASE }}
      aria-hidden="true"
    >
      <div className="peal-stage">
        {/* Plain divs, not motion components.
            
            A motion element writes its animation into the inline transform,
            which beats the class that places the card in space, so animating
            these individually collapsed all four onto the same spot. The
            entrance is the container fading in and a CSS delay per card; the
            position stays in CSS where the 3D lives. */}
        {cards.map((c, i) => (
          <div
            key={c.who}
            className={`peal-card peal-card-open${c.last ? ' peal-card-last' : ''}`}
            style={{ ['--i' as string]: i }}
          >
            <span className="peal-card-v">{c.v}</span>
            <span className="peal-card-w">{c.who}</span>
          </div>
        ))}
      </div>
      <p className="peal-scene-cap">every one of them legible on arrival</p>
    </motion.div>
  );
}

/**
 * The same four submissions, sealed, then opening together.
 *
 * The animation runs once when the section is reached rather than on a loop: it
 * is illustrating a thing that happens once, and a loop would suggest the
 * deadline comes round again.
 */
function SealedScene() {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      className={`peal-scene peal-scene-sealed${open ? ' is-open' : ''}`}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.8, ease: EASE }}
      onViewportEnter={() => {
        window.setTimeout(() => setOpen(true), 1600);
      }}
      aria-hidden="true"
    >
      <div className="peal-stage">
        {['$4,200', '$4,650', '$4,400', '$4,505'].map((v, i) => (
          <div className="peal-card peal-card-seal" key={v} style={{ ['--i' as string]: i }}>
            <span className="peal-card-lock" />
            <span className="peal-card-v">{v}</span>
            {/* The label has to follow the state, or the cards go on claiming
                to be sealed after the scene has shown them opening. */}
            <span className="peal-card-w">{open ? 'open' : 'sealed'}</span>
          </div>
        ))}
      </div>
      <p className="peal-scene-cap">
        {open ? 'the deadline passed, and every one opened at once' : 'unreadable until the deadline'}
      </p>
    </motion.div>
  );
}

function Problem() {
  return (
    <Section
      id="the-problem"
      eyebrow="The problem"
      title={
        <>
          In an open system, going first is a{' '}
          <span className="peal-em">disadvantage</span>.
        </>
      }
    >
      <p>
        Everything you send arrives readable. So the order you send in decides what happens to you.
        Bid early and your number is public while the auction is still running. Broadcast a
        transaction and it waits in a queue anyone can read and act on before it settles. Send a
        quote, a vote, a salary offer, and whoever moves next has seen it.
      </p>
      <OpenQueueScene />
      <p>
        The usual answer is to ask everyone to commit now and reveal later. That fails the same way
        every time: revealing is a move, and whoever is losing simply declines to make it. You are
        left with a protocol that works exactly when nobody minds the outcome.
      </p>
    </Section>
  );
}

function Solution() {
  return (
    <Section
      id="how-it-works"
      eyebrow="What Peal does"
      title={
        <>
          Peal holds it, and then opens it{' '}
          <span className="peal-em">without asking anyone</span>.
        </>
      }
    >
      <p>
        A round is a moment. Everything sealed to it is encrypted in your own process, so what
        crosses the network is already a ciphertext. Nobody can read it early: not the other
        participants, not the application owner, not the operators who run the network. While the
        round is open it will not even say how many submissions it is holding.
      </p>
      <SealedScene />
      <p>
        When the deadline arrives, three of five independent operators combine their shares and
        every submission opens at once. The reveal is not a participant&rsquo;s move, so there is
        nothing to withhold and nothing to decline. That single difference is what separates this
        from commit and reveal.
      </p>
    </Section>
  );
}

function Uses() {
  const items = [
    {
      k: 'Sealed bid auctions',
      v: 'Every bid stays unreadable until the close, then they all open and rank at once. Nobody can watch the leader and beat it by a pound in the last second.',
    },
    {
      k: 'Encrypted mempools',
      v: 'Transactions are ordered before they are readable, so there is nothing to read in front of. The order is fixed first and revealed second.',
    },
    {
      k: 'Private voting',
      v: 'Ballots are sealed until the poll closes, so nobody votes with the running tally in front of them and nobody can be shown to have voted a particular way early.',
    },
    {
      k: 'Quotes and procurement',
      v: 'Suppliers price the work rather than each other. No supplier can see another number before the deadline, including the buyer running the round.',
    },
    {
      k: 'Agent commitments',
      v: 'Two autonomous parties commit to a price or an action, sealed until a stated moment, with neither able to read the other first and neither holding an account with the other.',
    },
  ];
  return (
    <Section
      id="what-people-build"
      eyebrow="What it is for"
      title="Anywhere the order of arrival should not decide the outcome"
    >
      <ul className="peal-uses">
        {items.map((it, i) => (
          <motion.li
            key={it.k}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.55, delay: 0.06 * i, ease: EASE }}
          >
            <h3>{it.k}</h3>
            <p>{it.v}</p>
          </motion.li>
        ))}
      </ul>
    </Section>
  );
}

function Cost() {
  return (
    <Section
      id="what-you-need"
      eyebrow="What it costs"
      title={
        <>
          Three HTTP calls, and <span className="peal-em">nothing else</span>.
        </>
      }
    >
      <p>
        No API key, no account, no signup, no payment. Open a round, seal a payload to it, read it
        back after the deadline. The people submitting need no wallet, hold no tokens and pay no
        gas: sealing happens in their browser and arrives over ordinary HTTPS.
      </p>
      <div className="peal-calls">
        <code>POST /v1/rounds</code>
        <code>POST /v1/rounds/ID/seals</code>
        <code>GET&nbsp; /v1/rounds/ID</code>
      </div>
      <p>
        The client is one file with the encryption compiled into it, served from this site. If you
        would rather not add a dependency, every call above is plain JSON over HTTP and works from
        curl.
      </p>
    </Section>
  );
}

function Limits() {
  return (
    <Section
      id="what-it-does-not-do"
      eyebrow="Being straight with you"
      title="What Peal does not do"
    >
      <p>
        It does not keep anything secret for ever. A round is unreadable until its deadline and
        public afterwards, and that is the product rather than a limitation of it. If you need data
        that is never disclosed, this is the wrong tool.
      </p>
      <p>
        It does not hide that a round exists, who created it, or when it will open. Those are
        public from the moment it is made. What is hidden is the contents, and until the deadline,
        how many there are.
      </p>
      <p>
        And it is a devnet. The parameters, the addresses and the endpoints are stable and
        documented, the committee composition is published, and none of it is carrying real money
        yet.
      </p>
    </Section>
  );
}

function Close() {
  return (
    <section className="peal-sec peal-close">
      <div className="peal-sec-inner">
        <motion.h2
          className="peal-h2"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          Seal something and watch it open.
        </motion.h2>
        <motion.div
          className="peal-cta-row"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, delay: 0.1, ease: EASE }}
        >
          <a className="peal-cta" href="#/developers/quickstart">
            Run the three calls
          </a>
          <a className="peal-cta peal-cta-quiet" href="#/developers">
            Read the documentation
          </a>
        </motion.div>
        <p className="peal-close-note">
          The quickstart runs against the live network from the page itself. Nothing to install and
          nothing to sign up for.
        </p>
      </div>
    </section>
  );
}

function App() {
  return (
    <div className="peal-landing relative min-h-screen bg-[#F3F4ED]">
      <Navbar />
      <Hero />
      <main>
        <Problem />
        <Solution />
        <Uses />
        <Cost />
        <Limits />
        <Close />
      </main>
    </div>
  );
}

export function renderLanding(root: HTMLElement): () => void {
  // The title is left alone on purpose.
  //
  // This used to overwrite it with the hero line, which threw away the title
  // the server had already written into the document: the one in the sitemap,
  // the one the structured data names, and the one chosen for what people
  // search. Search engines run this JavaScript, so the overwrite was the
  // version they saw.

  const reactRoot = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  return () => {
    reactRoot.unmount();
  };
}

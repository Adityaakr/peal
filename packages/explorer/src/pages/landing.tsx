// The landing page (#/): a React island that replaces the old vanilla-TS hero.
//
// It is mounted by main.ts's router via renderLanding(root) and unmounted on
// the next hash change. Design: a full-bleed hero video with a frosted pill
// navbar, the "Secrets that Open Themselves" display headline, and the Peal
// pitch. Nokia-font messages type themselves onto the phone in the video.
//
// Content is Peal's own — only the structure/motion follow the supplied spec.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motion, useScroll, useTransform } from 'motion/react';
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
        <a href="/" className="flex items-center gap-2">
          <img className="landing-nav-logo" src="/peal-logo.png" alt="" width={36} height={36} />
          <span className="font-display font-medium text-[26px] tracking-tight text-[#1a1a1a] leading-none">
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

/** The badge, at 180 wide. Same 250 by 54 artwork, exact ratio kept. */
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
        width={180}
        height={39}
      />
    </a>
  );
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  /* The scrub runs from the hero sitting at the top of the viewport to the hero
     having left it, so the zoom is tied to the scroll rather than to a timer and
     it holds still when the reader does. */
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const zoom = useTransform(scrollYProgress, [0, 1], [1, 1.16]);

  return (
    <section ref={ref} className="peal-hero">
      {/* The media is a rounded card inset to the same gutter the sections use,
          rather than a full bleed panel, so the fold lines up with everything
          under it instead of running past it on both sides. */}
      <div className="peal-hero-media">
        <motion.video
          className="peal-hero-video"
          style={{ scale: zoom }}
          autoPlay
          loop
          muted
          playsInline
          src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260427_054418_a6d194f0-ac86-4df9-abe5-ded73e596d7c.mp4"
        />
        <div className="peal-hero-veil" />

        <TypingMessages />

        <div className="peal-hero-copy">
          {/* The h1, not a div. This page had no heading of any level, which on the
              one URL every inbound link points at is the cheapest thing to get
              wrong and the cheapest to fix. */}
          <motion.h1
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.5, ease: EASE }}
            className="peal-hero-title"
          >
            Secrets that
            <br />
            Open Themselves
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.2, delay: 0.2, ease: EASE }}
            className="peal-hero-cta-row"
          >
            <a className="peal-hero-cta" href="#/app">
              <span aria-hidden className="peal-hero-cta-gloss" />
              <span>Launch App</span>
            </a>
          </motion.div>
        </div>

        {/* The badge sits in the corner rather than in the stack under the
            headline. Bottom right, not top right: the copy is centred and on a
            phone a top corner badge lands on the second line of the title. */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.5, ease: EASE }}
          className="peal-hero-badge"
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


/**
 * Three of five, and you can try it.
 *
 * The threshold is the whole trust model and it is the one claim people are
 * right to be sceptical about, so this lets them check it rather than read it:
 * toggle operators and watch whether the payload opens. Two never opens it. Any
 * three do, and it does not matter which three.
 */
function CommitteeScene() {
  const [on, setOn] = useState<number[]>([0, 1]);
  const opens = on.length >= 3;
  const toggle = (i: number) =>
    setOn((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));

  return (
    <div className={`peal-committee${opens ? ' is-open' : ''}`}>
      <div className="peal-cmt-stage">
        {/* Back plane: the payload. Sealed it is the ciphertext, because that is
            genuinely all there is to see, and it comes forward as it opens. */}
        <div className="peal-cmt-payload">
          <span className="peal-cmt-lock" />
          <span className="peal-cmt-v">{opens ? '$4,505' : '8f2c…a91d'}</span>
          <span className="peal-cmt-w">{opens ? 'open' : 'sealed'}</span>
        </div>

        {/* Mid plane: one share per operator that is holding one, travelling up
            to the payload. Three arriving is the entire mechanism, so it is the
            thing that moves rather than a state the caption asserts. */}
        <div className="peal-cmt-shares">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`peal-cmt-share${on.includes(i) ? ' is-sent' : ''}`}
              /* Where it starts, on its own operator, and where it lands. The
                 landing spots are spread rather than shared: five shares
                 converging on one pixel render as one share. */
              style={{
                ['--x' as string]: `${(i - 2) * 76}px`,
                ['--to' as string]: `${(i - 2) * 21}px`,
              }}
            />
          ))}
        </div>

        {/* Front plane: how far off the threshold is, counted rather than said.
            It fills to three and stops, because a fourth share adds nothing. */}
        <div className="peal-cmt-meter" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className={`peal-cmt-tick${on.length > i ? ' is-lit' : ''}`} />
          ))}
          <em>{Math.min(on.length, 3)} of 3 shares</em>
        </div>

        <div className="peal-cmt-row">
          {[0, 1, 2, 3, 4].map((i) => (
            <button
              key={i}
              type="button"
              className={`peal-cmt-node${on.includes(i) ? ' is-on' : ''}`}
              style={{ ['--i' as string]: i }}
              onClick={() => toggle(i)}
              aria-pressed={on.includes(i)}
              aria-label={`operator ${i + 1}, ${on.includes(i) ? 'holding a share' : 'not participating'}`}
            >
              <span className="peal-cmt-key" />
              <span className="peal-cmt-n">{i + 1}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="peal-cmt-cap">
        <strong>{on.length} of 5</strong>{' '}
        {opens
          ? 'operators combined their shares, so it opened. Any three will do.'
          : 'is not enough. Turn on one more and it opens; it does not matter which.'}
      </p>
    </div>
  );
}

/**
 * The deadline arriving with nobody present.
 *
 * The point being made is negative, which is hard to draw: what matters is that
 * no participant does anything. So the marker crosses the line on its own and
 * the caption says who acted, which is nobody.
 */
function DeadlineScene() {
  const [fired, setFired] = useState(false);
  return (
    <div
      className={`peal-timeline${fired ? ' is-fired' : ''}`}
      onMouseEnter={() => setFired(true)}
    >
      <motion.div
        className="peal-tl-track"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.6, ease: EASE }}
        onViewportEnter={() => {
          window.setTimeout(() => setFired(true), 1800);
        }}
      >
        <span className="peal-tl-line" />
        <span className="peal-tl-mark peal-tl-open">
          <em>round opens</em>
        </span>
        <span className="peal-tl-mark peal-tl-close">
          <em>deadline</em>
        </span>
        <span className="peal-tl-runner" />
      </motion.div>
      <p className="peal-tl-cap">
        {fired
          ? 'the network opened it. no participant was asked, and none could refuse.'
          : 'sealed, and counting down'}
      </p>
    </div>
  );
}

/**
 * The batch, drawn.
 *
 * This is the claim the rest of the page leans on without ever showing it: a
 * round is not opened one submission at a time. Sixty-four slots share a single
 * threshold decryption, and the slots that carried nothing are padding that
 * looks exactly like the slots that did. So the grid opens in one movement
 * rather than in a stagger, because a stagger would draw the wrong thing.
 *
 * Depth is translateZ under a perspective and nothing else. No rotation: a
 * rotated grid foreshortens its own hairlines unevenly and sixty-four of them
 * would show it.
 */
const BATCH_SLOTS = 64;

/* Which slots carried a submission. Fixed rather than random so the number in
   the caption and the number of filled squares can never disagree. */
const FILLED = new Set([
  1, 3, 4, 9, 12, 13, 17, 20, 22, 26, 27, 31, 33, 35, 38, 40,
  41, 45, 47, 50, 52, 55, 58, 61,
]);

function BatchScene() {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`peal-batch${open ? ' is-open' : ''}`}
      onMouseEnter={() => setOpen(true)}
    >
      <motion.div
        className="peal-batch-stage"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.8, ease: EASE }}
        onViewportEnter={() => {
          window.setTimeout(() => setOpen(true), 2000);
        }}
        aria-hidden="true"
      >
        <div className="peal-batch-grid">
          {Array.from({ length: BATCH_SLOTS }, (_, i) => {
            const col = i % 8;
            const row = Math.floor(i / 8);
            /* A shallow dome: the middle of the field sits nearest the reader
               and the corners fall away, so sixty-four flat squares still read
               as one object with depth. */
            const z = 30 - (Math.abs(col - 3.5) + Math.abs(row - 3.5)) * 7;
            return (
              <span
                key={i}
                className={`peal-slot${FILLED.has(i) ? ' is-filled' : ''}`}
                style={{ ['--z' as string]: `${z}px` }}
              >
                <span className="peal-slot-bar" />
              </span>
            );
          })}
        </div>
        <span className="peal-batch-op">
          {open ? '1 threshold decryption' : '64 slots, sealed'}
        </span>
      </motion.div>
      <p className="peal-batch-cap">
        {open
          ? `all ${BATCH_SLOTS} opened from it. ${FILLED.size} carried a submission, ${BATCH_SLOTS - FILLED.size} were padding.`
          : 'every slot the same from outside, whether or not anything is in it'}
      </p>
    </div>
  );
}

/**
 * The sandwich, drawn, in both lanes at once.
 *
 * The public lane is the whole attack in three cards: a searcher reads the
 * pending swap, buys in front of it and sells behind it, and the swap fills at
 * a price the searcher moved. The sealed lane runs the same three actors and
 * the attack has nowhere to attach, because the order is a ciphertext until the
 * batch opens.
 *
 * Depth is translateZ under a perspective and nothing else, so the two lanes
 * can be compared without either being foreshortened more than the other.
 */
function MempoolScene() {
  const [attacked, setAttacked] = useState(false);
  return (
    <motion.div
      className={`peal-mp${attacked ? ' is-attacked' : ''}`}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: EASE }}
      onViewportEnter={() => {
        window.setTimeout(() => setAttacked(true), 1400);
      }}
      onMouseEnter={() => setAttacked(true)}
      aria-hidden="true"
    >
      <div className="peal-mp-lane peal-mp-open">
        <span className="peal-mp-tag">a public mempool</span>
        <div className="peal-mp-stack">
          <span className="peal-mp-card peal-mp-atk peal-mp-front">
            <b>buy</b>
            <i>in front of it</i>
          </span>
          <span className="peal-mp-card peal-mp-victim">
            <b>swap 10 ETH</b>
            <i>readable while pending</i>
          </span>
          <span className="peal-mp-card peal-mp-atk peal-mp-back">
            <b>sell</b>
            <i>behind it</i>
          </span>
        </div>
        <span className="peal-mp-out">filled at a price the searcher moved</span>
      </div>

      <div className="peal-mp-lane peal-mp-shut">
        <span className="peal-mp-tag">the same block, sealed</span>
        <div className="peal-mp-stack">
          <span className="peal-mp-card peal-mp-atk peal-mp-front">
            <b>buy</b>
            <i>in front of what?</i>
          </span>
          <span className="peal-mp-card peal-mp-victim peal-mp-ct">
            <b>0x7f3a…c210</b>
            <i>ciphertext until the block</i>
          </span>
          <span className="peal-mp-card peal-mp-atk peal-mp-back">
            <b>sell</b>
            <i>behind what?</i>
          </span>
        </div>
        <span className="peal-mp-out">filled at the quote</span>
      </div>
    </motion.div>
  );
}

/**
 * A sealed book that ranks itself.
 *
 * Five bids arrive at different times and the last one arrives knowing nothing,
 * which is the property the whole mechanism exists to buy. On the close they
 * all resolve together and the winner comes forward. No card is flipped by a
 * rotation: a rotated card slants its own type on the way round, and the
 * resting state is what has to be legible.
 */
/* Arrival order, with where each one lands once they are ranked. The ranks are
   written down rather than sorted at runtime so the caption's claim about the
   last bid can never disagree with the card that moves. */
const BIDS = [
  { at: 'day 1', v: '$4,200', rank: 3 },
  { at: 'day 3', v: '$4,650', rank: 0 },
  { at: 'day 6', v: '$4,400', rank: 2 },
  { at: 'last minute', v: '$4,505', rank: 1, late: true },
  { at: 'day 8', v: '$4,180', rank: 4 },
];

function AuctionScene() {
  const [closed, setClosed] = useState(false);
  return (
    <motion.div
      className={`peal-auc${closed ? ' is-closed' : ''}`}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: EASE }}
      onViewportEnter={() => {
        window.setTimeout(() => setClosed(true), 1800);
      }}
      onMouseEnter={() => setClosed(true)}
      aria-hidden="true"
    >
      <div className="peal-auc-stage">
        <span className="peal-auc-axis">
          <em className="peal-auc-axis-l">{closed ? 'highest' : 'first in'}</em>
          <em className="peal-auc-axis-r">{closed ? 'lowest' : 'last in'}</em>
        </span>

        <div className="peal-auc-book">
          {BIDS.map((b, i) => (
            <span
              key={b.at}
              className={`peal-auc-bid${b.rank === 0 ? ' is-top' : ''}${b.late ? ' is-late' : ''}`}
              /* Two positions per card: where it arrived, and where it belongs
                 once every bid is readable. The close moves it between them,
                 which is the whole of what a sealed book buys you. */
              style={{ ['--i' as string]: i, ['--r' as string]: b.rank }}
            >
              <b>{closed ? b.v : '••••••'}</b>
              <i>{b.at}</i>
              <u className="peal-auc-rank">{b.rank + 1}</u>
            </span>
          ))}
        </div>
      </div>
      <p className="peal-auc-cap">
        {closed
          ? 'the close re-ordered the book by value. the bid that arrived last came second, and waiting until the end bought nothing.'
          : 'five bids in arrival order, and not one of them readable, including by whoever is running the auction'}
      </p>
    </motion.div>
  );
}

/**
 * The 402 handshake, with the numbers the live gateway actually returns.
 *
 * Three panels at three depths, advancing on their own, because the thing worth
 * showing is that there is no fourth step: no account, no key, no invoice.
 */
const X402_STEPS = [
  { n: 'POST /v1/x402/rounds', r: '402 Payment Required', d: 'the server says what the call costs' },
  { n: 'transfer 0.001 USD', r: 'paid on chain', d: 'the agent pays, from its own wallet' },
  { n: 'retry with X-PAYMENT', r: '201 Created', d: 'the round is open. no account was made' },
];

function X402Scene() {
  const [step, setStep] = useState(-1);
  return (
    <motion.div
      className="peal-x4"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: EASE }}
      onViewportEnter={() => {
        [0, 1, 2].forEach((i) => window.setTimeout(() => setStep(i), 900 + i * 900));
      }}
      aria-hidden="true"
    >
      {X402_STEPS.map((s, i) => (
        <span
          key={s.n}
          className={`peal-x4-step${step >= i ? ' is-on' : ''}`}
          style={{ ['--i' as string]: i }}
        >
          <code>{s.n}</code>
          <b>{s.r}</b>
          <i>{s.d}</i>
        </span>
      ))}
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
        Everything you send arrives readable, so the order you send in decides what happens to
        you. Bid early and your number is public while the auction is still running.
      </p>
      <OpenQueueScene />
      <p>
        The usual answer is commit now, reveal later. It fails the same way every time: revealing
        is a move, and whoever is losing declines to make it.
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
        crosses the network is already a ciphertext. Nobody reads it early: not the other
        participants, not you, not the operators.
      </p>
      <SealedScene />
      <p>
        At the deadline, three of five independent operators combine their shares and every
        submission opens at once. The reveal is not a participant&rsquo;s move, so there is
        nothing to withhold.
      </p>
    </Section>
  );
}

function Committee() {
  return (
    <Section
      id="who-can-open-it"
      eyebrow="The trust model"
      title={
        <>
          It takes three of five. <span className="peal-em">Try it.</span>
        </>
      }
    >
      <p>
        No single party holds a key that opens anything, us included. It is split across five
        operators and takes three of them to use. Two can be offline, compromised or simply
        refusing, and the round still opens on time.
      </p>
      <CommitteeScene />
      <p>
        This is the claim to be most sceptical of, so it is not a diagram. Turn operators off and
        watch: two never opens it, any three do.
      </p>
    </Section>
  );
}

function Deadline() {
  return (
    <Section
      id="nobody-has-to-come-back"
      eyebrow="Why this is not commit and reveal"
      title={
        <>
          Nobody has to <span className="peal-em">come back</span>.
        </>
      }
    >
      <p>
        Every commit and reveal scheme has the same hole. Revealing can be declined, and the
        person most likely to decline is the one who has just worked out they lost.
      </p>
      <DeadlineScene />
      <p>
        A Peal round opens because the deadline arrived, not because anyone chose to. No reveal
        step to skip, no bond to slash for skipping it, no timeout branch to write.
      </p>
    </Section>
  );
}

function Batch() {
  return (
    <Section
      id="how-it-scales"
      eyebrow="Why the cost does not grow"
      title={
        <>
          One decryption opens <em className="peal-em">the whole batch</em>.
        </>
      }
    >
      <p>
        A round is not opened one submission at a time. Sixty-four slots share a single threshold
        decryption, so a round holding sixty submissions costs what a round holding one costs.
      </p>
      <BatchScene />
      <p>
        The slots that carried nothing are padding, indistinguishable from the ones that did. From
        outside, a full slot and an empty one are the same ciphertext.
      </p>
    </Section>
  );
}

/** The two links under a showcase section: the thing itself, then the reading. */
function TryRow({ href, label, more, moreLabel }: { href: string; label: string; more: string; moreLabel: string }) {
  return (
    <motion.p
      className="peal-try"
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <a className="peal-try-go" href={href}>
        {label}
      </a>
      <a className="peal-try-more" href={more}>
        {moreLabel}
      </a>
    </motion.p>
  );
}

function Mempool() {
  return (
    <Section
      id="encrypted-mempool"
      eyebrow="Encrypted mempools"
      title={
        <>
          A sandwich needs something to read. <em className="peal-em">Take it away</em>.
        </>
      }
    >
      <p>
        A searcher reads a pending swap, buys in front of it and sells behind it. The swap fills
        worse and the difference is the searcher&rsquo;s. It is the ordinary cost of a queue that
        is legible before it settles.
      </p>
      <MempoolScene />
      <p>
        Peal seals the order to the block it belongs in. While it is pending it is a ciphertext,
        so there is no number to trade in front of. The searcher is not blocked from acting. There
        is nothing to act on.
      </p>
      <TryRow
        href="#/encrypted-mempool"
        label="Get sandwiched, then don't"
        more="#/mempool"
        moreLabel="How the sealed lane works"
      />
      <p className="peal-fine">
        The demo is not a drawing. Both pools are real contracts on a public testnet, the searcher
        is a real bot, and the sealed order settles through <code>PealMempool.executeBatch</code>.
        The committee&rsquo;s keys still come from a trusted dealer rather than a distributed key
        generation, so the honest statement is that a dishonest operator could read early today.
        The cryptography and the settlement are real. That part of the trust model is not finished.
      </p>
    </Section>
  );
}

function Auction() {
  return (
    <Section
      id="sealed-bid-auctions"
      eyebrow="Sealed bid auctions"
      title={
        <>
          The last bid in <em className="peal-em">learns nothing</em>.
        </>
      }
    >
      <p>
        An open book turns an auction into a waiting game. The winning bid is often not the one
        that valued the thing most, just the one that arrived last with everybody else&rsquo;s
        number in front of it.
      </p>
      <AuctionScene />
      <p>
        A Peal auction has a close rather than a race. Bids go in sealed and rank on the deadline,
        from numbers nobody could read while bidding was open, the seller included.
      </p>
      <TryRow
        href="#/create"
        label="Run a sealed auction"
        more="#/auction"
        moreLabel="How sealed bidding works"
      />
      <p className="peal-fine">
        The live auction seals bids with salted commitments today. Peal&rsquo;s threshold encryption
        is not wired into it yet, which is why the auction pages mark that as build rather than
        live, and why a bidder who loses their salt is refunded instead of allocated.
      </p>
    </Section>
  );
}

function Agents() {
  return (
    <Section
      id="agents-and-x402"
      eyebrow="Machine customers"
      title={
        <>
          An agent cannot sign up. It can <em className="peal-em">pay for one call</em>.
        </>
      }
    >
      <p>
        An agent cannot accept terms, hold a key it did not earn, or wait for somebody to approve
        an invoice. It can do exactly one commercial thing well, which is pay for a single
        request.
      </p>
      <p>
        x402 is HTTP 402 used as specified: the server states a price, the caller pays on chain,
        then asks again carrying the proof. Every route is mounted twice, free at <code>/v1</code>
        and metered at <code>/v1/x402</code>.
      </p>
      <X402Scene />
      <p>
        No account was created, no key was issued and no invoice exists. That is what makes it
        usable by software that did not exist when your signup form was written.
      </p>
      <TryRow
        href="/developers/x402"
        label="Wire up a paid call"
        more="/developers/agents"
        moreLabel="The agent skill"
      />
    </Section>
  );
}

function Uses() {
  /* Each of these is a market that already exists and already pays somebody to
     police the ordering problem by hand. The `how` line is the actual shape the
     API takes, so a reader can tell whether their case fits without opening the
     documentation first. */
  const items = [
    {
      k: 'Procurement and tenders',
      v: 'Suppliers price the work instead of pricing each other. Nobody sees another number before the deadline, the buyer included.',
      how: "tag: 'rfq:<tender>' · one condition per tender",
    },
    {
      k: 'Sealed bid auctions',
      v: 'Spectrum, carbon, freight, secondary equity, domain names, liquidations. Every bid opens at the close and ranks at once, so arriving last buys nothing.',
      how: "tag: 'auction:<id>' · one seal per bid",
    },
    {
      k: 'Encrypted order flow',
      v: 'Orders seal to the block they belong in, so the queue is fixed before it is readable. There is no number to trade in front of.',
      how: "kind: 'at_block' · one condition per block height",
    },
    {
      k: 'Agent commitments, paid per call',
      v: 'Two agents commit to a price or an action, sealed until a stated moment, neither able to read the other first. x402 settles the call, so neither needs an account.',
      how: 'POST /v1/x402/rounds · 0.001 USD per call',
    },
    {
      k: 'Compensation and offers',
      v: 'Offers, counter-offers and salary bands open together on a stated date. Nobody negotiates against a number they were shown early.',
      how: "tag: 'offer:<req>' · one condition per requisition",
    },
    {
      k: 'Governance and voting',
      v: 'Ballots stay sealed until the poll closes, so no running tally can start a bandwagon. The count is computable by anyone afterwards.',
      how: "tag: 'vote:<proposal>' · one condition per poll",
    },
    {
      k: 'Forecasts and research calls',
      v: 'Analysts, desks and prediction tournaments submit into a sealed window. Nobody copies a better forecaster and nobody edits after the outcome.',
      how: "tag: 'round:<n>' · one condition per window",
    },
    {
      k: 'Grants, bounties and admissions',
      v: 'Applications and reviewer scores open together, so reviewers do not anchor on each other and nobody is ranked by who submitted first.',
      how: "tag: 'panel:<cycle>' · scores as payloads",
    },
    {
      k: 'Embargoed disclosure',
      v: 'Earnings, a security advisory, an index rebalance, a press release. The embargo holds itself, and lifts for everybody at the same instant.',
      how: "kind: 'at_time' · one condition per embargo",
    },
    {
      k: 'Token launches and allocations',
      v: 'Allocation requests are sealed until the window shuts, so the size of the book cannot be traded on while it is filling.',
      how: "tag: 'sale:<round>' · slots padded to the batch",
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
            transition={{ duration: 0.55, delay: 0.04 * (i % 5), ease: EASE }}
          >
            <h3>{it.k}</h3>
            <p>{it.v}</p>
            <p className="peal-uses-how">{it.how}</p>
          </motion.li>
        ))}
      </ul>
      <p className="peal-uses-tail">
        The shape is the same every time: people commit to something they cannot take back, and
        nobody sees anybody else&rsquo;s until they all open together.{' '}
        <a href="/developers/usecases">Twelve of these are worked through in the documentation</a>.
      </p>
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
        back after the deadline. That is the whole integration.
      </p>
      <div className="peal-calls">
        <code>POST /v1/rounds</code>
        <code>POST /v1/rounds/ID/seals</code>
        <code>GET&nbsp; /v1/rounds/ID</code>
      </div>
      <p>
        The client is one file with the encryption compiled in, served from this site. Skip it and
        every call above is plain JSON over HTTP.
      </p>
    </Section>
  );
}

/**
 * What is public and what is not.
 *
 * This replaced a section headed "What Peal does not do", which read as an
 * apology for the product. Every fact in it was worth keeping and one of them
 * was the strongest thing on the page, so the facts stayed and the framing
 * went: a developer deciding whether to build on this needs the privacy
 * boundary stated exactly, and stating it exactly is not a concession.
 */
function Boundary() {
  const rows = [
    { k: 'That a round exists', v: 'public', pub: true },
    { k: 'Who created it and when it opens', v: 'public', pub: true },
    { k: 'What is sealed inside it', v: 'nobody, until the deadline', pub: false },
    { k: 'How many submissions it holds', v: 'nobody, until the deadline', pub: false },
    { k: 'Everything, after the deadline', v: 'public', pub: true },
  ];
  return (
    <Section
      id="what-is-public"
      eyebrow="The boundary, exactly"
      title={
        <>
          Sealed until the deadline. <span className="peal-em">Public after it.</span>
        </>
      }
    >
      <p>
        Peal is not a way to keep something secret for ever, and that is the product rather than a
        gap in it. A round is unreadable until the moment it names, and public from then on.
      </p>
      <ul className="peal-boundary">
        {rows.map((r, i) => (
          <motion.li
            key={r.k}
            className={r.pub ? 'is-public' : 'is-sealed'}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: 0.05 * i, ease: EASE }}
          >
            <span>{r.k}</span>
            <em>{r.v}</em>
          </motion.li>
        ))}
      </ul>
      <p>
        If you need data nobody ever sees, this is the wrong tool. If you need data nobody can act
        on early and everybody can verify afterwards, this is the whole of it.
      </p>
    </Section>
  );
}

/**
 * The questions people actually ask.
 *
 * The wording here is duplicated, deliberately, in `faqs_for("")` in
 * crates/bte-coordinator/src/pages.rs, which emits the FAQPage structured data
 * for this URL. Structured data is only allowed to describe content that is
 * actually on the page, so if one of these is edited the other has to move with
 * it or the markup becomes a claim about a page that does not exist.
 */
const FAQS: Array<[string, React.ReactNode]> = [
  [
    'What is Peal, in one sentence?',
    <>
      The programmable confidentiality layer for digital markets. You collect encrypted bids,
      offers, votes, commitments and agent intents, and they open only when a condition you set is
      met.
    </>,
  ],
  [
    'Do the people submitting need a wallet or any crypto?',
    <>
      No. Sealing happens in their browser or in your own code and goes over ordinary HTTPS. No
      wallet, no account, no gas, and they never touch a chain. That is usually the difference
      between a mechanism you can ship to your users and one you can only ship to crypto users.
    </>,
  ],
  [
    'Who can read a submission before the deadline?',
    <>
      Nobody. Not the other participants, not you as the application owner, and not the operators
      running the network. The decryption key is split across five independent operators and no
      three of them combine their shares until the condition fires.
    </>,
  ],
  [
    'What stops somebody refusing to reveal when they see they have lost?',
    <>
      There is nothing for them to refuse. Opening a round is not a participant&rsquo;s move, so a
      losing bidder walking away costs everyone else nothing. That single difference is what
      separates this from every commit and reveal scheme, all of which break in exactly that spot.
    </>,
  ],
  [
    'What if an operator goes offline?',
    <>
      Three of the five are enough, so two can be down, unreachable or actively refusing and the
      round still opens on time. You can check that claim on this page rather than take it on
      trust: the committee above is interactive.
    </>,
  ],
  [
    'How can someone start building using Peal?',
    <>
      Fastest is the quickstart, which runs the three calls against the live network from the page
      itself, so you can watch a round open before you have written anything. If you build with an
      agent or a coding assistant, <code>curl -fsSL https://peal.network/skill/install.sh | sh</code>{' '}
      installs a skill carrying a reference for the API, the errors, timing, payments, verification
      and building the interface, and the assistant then knows the endpoints without you pasting
      documentation at it. There is an <code>llms.txt</code> at the root for any model that reads
      one, and <code>peal.js</code> if you would rather seal in the visitor&rsquo;s own browser with
      no build step. If none of that appeals, it is three HTTP calls with no key and no account, so
      curl is a perfectly good client.
    </>,
  ],
  [
    'What does it cost?',
    <>
      Nothing. No key, no account, no signup and no card. Every route is also mounted at{' '}
      <code>/v1/x402</code> for callers who want to pay per request, currently 0.001 USD, and
      that twin is opt in. The free API is not degraded to make the paid one look better.
    </>,
  ],
  [
    'Is this actually running, or is it a paper?',
    <>
      Running. The quickstart executes against the live network from the documentation page itself,
      the encrypted mempool demo settles real transactions against real contracts on a public
      testnet, and the committee, parameters and endpoints are published. It is a devnet, so none
      of it is carrying real money yet.
    </>,
  ],
  [
    'How is this different from encrypting something and handing over the key later?',
    <>
      Somebody has to be holding that key, and holding it is the same thing as being able to use it
      early, lose it, or be compelled to produce it. Here no single party ever holds the key, and
      the release is triggered by the condition rather than by a person deciding the moment has
      come.
    </>,
  ],
  [
    'How much can one round hold?',
    <>
      Sixty-four slots, opened by a single threshold decryption, so a round holding sixty
      submissions costs what a round holding one costs. Slots that carried nothing are padding and
      are indistinguishable from the ones that did, which is why an open round will not tell you
      how many submissions it is holding.
    </>,
  ],
];

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <Section
      id="questions"
      eyebrow="Questions"
      title={
        <>
          The things people <em className="peal-em">ask first</em>
        </>
      }
    >
      <ul className="peal-faq">
        {FAQS.map(([q, a], i) => (
          <motion.li
            key={q}
            className={open === i ? 'is-open' : ''}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: 0.03 * (i % 5), ease: EASE }}
          >
            <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span>{q}</span>
              <span className="peal-faq-mark" aria-hidden="true" />
            </button>
            {/* Rendered whether or not it is open, and hidden with CSS.
                An answer that is not in the DOM is not on the page, and the
                structured data for this URL says these answers are on it. */}
            <div className="peal-faq-a">
              <p>{a}</p>
            </div>
          </motion.li>
        ))}
      </ul>
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
        {/* Dropped from the section above when it was reframed, and it should
            not be dropped from the page: somebody deciding whether to build on
            this is entitled to know. */}
        <p className="peal-close-note peal-close-fine">
          Peal is a devnet. The parameters, the addresses and the endpoints are stable and
          documented, and the committee composition is published. None of it is carrying real
          money yet.
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
        <Deadline />
        <Committee />
        <Batch />
        <Mempool />
        <Auction />
        <Agents />
        <Uses />
        <Cost />
        <Boundary />
        <Faq />
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

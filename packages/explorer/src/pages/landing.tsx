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
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.5, ease: EASE }}
          className="font-instrument text-[38px] md:text-[56px] lg:text-[72px] leading-[0.85] tracking-tight text-[#1a1a1a] mb-6"
        >
          Secrets that
          <br />
          Open Themselves
        </motion.div>

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

function App() {
  return (
    <div className="peal-landing relative min-h-screen bg-[#F3F4ED]">
      <Navbar />
      <Hero />
    </div>
  );
}

export function renderLanding(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Network. Secrets that open themselves';

  const reactRoot = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  return () => {
    reactRoot.unmount();
    document.title = previousTitle;
  };
}

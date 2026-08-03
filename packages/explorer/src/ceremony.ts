// The sealing ceremony: a small 3D scene that shows what "seal" actually does.
// A secret is encrypted in this tab, its key is split into n shares, and one
// share travels to each operator in the committee, any t of which can reveal
// on the cue. Nothing here is decorative-only: n, t and the verified-share
// count are the real values from the coordinator, so the picture stays honest.
//
// Dependency-free (CSS 3D transforms + a light rAF orbit, no three.js). Once
// sealed, the committee slowly orbits so the depth reads as depth. All motion
// is gated behind prefers-reduced-motion; under it the scene is static.

export interface Ceremony {
  /** Root element to mount. */
  el: HTMLElement;
  /** Run the encrypt -> split -> distribute intro. Resolves when settled. */
  play(): Promise<void>;
  /** Live: light the first `count` operators as their shares verify. */
  setVerified(count: number): void;
  /** Reveal burst: every slot opens at once. */
  reveal(): void;
  destroy(): void;
}

interface CeremonyOpts {
  n: number;
  t: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function prefersReduced(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Perspective ellipse the committee sits on. ry << rx so the ring reads as a
// tilted disc; depth (0 at back, 1 at front) drives per-node scale and opacity.
const CX = 50;
const CY = 50;
const RX = 41;
const RY = 15;

export function createCeremony({ n, t }: CeremonyOpts): Ceremony {
  const reduce = prefersReduced();

  const el = document.createElement('div');
  el.className = 'cer';
  el.dataset.phase = 'idle';
  el.setAttribute('role', 'img');
  el.setAttribute(
    'aria-label',
    `your secret, sealed to ${n} operators. any ${t} of ${n} can reveal it on the cue.`,
  );

  const stage = document.createElement('div');
  stage.className = 'cer-stage';

  const ring = document.createElement('div');
  ring.className = 'cer-ring';
  stage.appendChild(ring);

  const floor = document.createElement('div');
  floor.className = 'cer-floor';
  stage.appendChild(floor);

  // The sealed ciphertext at the center.
  const core = document.createElement('div');
  core.className = 'cer-core';
  core.innerHTML =
    '<span class="cer-core-glow" aria-hidden="true"></span>' +
    '<span class="cer-core-face" aria-hidden="true"></span>' +
    '<img class="cer-core-logo" src="/peal-logo.png" alt="" aria-hidden="true" />';
  stage.appendChild(core);

  interface Node {
    el: HTMLElement;
    base: number;
  }
  const nodes: Node[] = [];

  function place(node: HTMLElement, ang: number): { x: number; y: number } {
    const x = CX + RX * Math.cos(ang);
    const y = CY + RY * Math.sin(ang);
    const depth = (Math.sin(ang) + 1) / 2; // 1 at front (bottom), 0 at back
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    node.style.setProperty('--depth', depth.toFixed(3));
    node.style.zIndex = String(8 + Math.round(depth * 14));
    return { x, y };
  }

  for (let i = 0; i < n; i++) {
    const base = Math.PI / 2 + (i / n) * Math.PI * 2;

    const node = document.createElement('div');
    node.className = 'cer-node';
    node.style.setProperty('--i', String(i));
    const { x, y } = place(node, base);
    node.innerHTML =
      '<span class="cer-node-ring" aria-hidden="true"></span>' +
      `<span class="cer-node-tag">op ${i + 1}</span>`;
    stage.appendChild(node);
    nodes.push({ el: node, base });

    // One key-shard per node. It flies from the core to the node's start
    // position (the orbit only begins after the shards have landed).
    const shard = document.createElement('span');
    shard.className = 'cer-shard';
    shard.setAttribute('aria-hidden', 'true');
    shard.style.setProperty('--i', String(i));
    shard.style.setProperty('--tx', `${x}%`);
    shard.style.setProperty('--ty', `${y}%`);
    stage.appendChild(shard);
  }

  const caption = document.createElement('p');
  caption.className = 'cer-caption';
  caption.textContent = 'sealing…';

  el.appendChild(stage);
  el.appendChild(caption);

  // ---- gentle orbit so the perspective reads as depth --------------------
  let rot = 0;
  let raf = 0;
  let last = 0;
  let orbiting = false;

  function frame(ts: number): void {
    if (!orbiting) return;
    if (!last) last = ts;
    const dt = (ts - last) / 1000;
    last = ts;
    rot += dt * 0.16; // radians/sec, slow
    for (const nd of nodes) place(nd.el, nd.base + rot);
    raf = requestAnimationFrame(frame);
  }

  function startOrbit(): void {
    if (reduce || orbiting) return;
    orbiting = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stopOrbit(): void {
    orbiting = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function paintVerified(count: number): void {
    nodes.forEach((nd, i) => nd.el.classList.toggle('is-verified', i < count));
    el.setAttribute(
      'aria-label',
      `${count} of ${n} operator shares verified, ${t} needed to reveal.`,
    );
  }

  async function play(): Promise<void> {
    if (reduce) {
      el.dataset.phase = 'sealed';
      caption.textContent = `sealed to ${n} operators. any ${t} of ${n} reveal on the cue.`;
      return;
    }
    el.dataset.phase = 'encrypt';
    caption.textContent = 'encrypting in this tab. nobody can read it, us included.';
    await wait(950);
    el.dataset.phase = 'split';
    caption.textContent = `splitting the key into ${n} shares.`;
    await wait(700);
    el.dataset.phase = 'distribute';
    caption.textContent = 'handing one share to each operator.';
    await wait(400 + n * 130 + 550);
    el.dataset.phase = 'sealed';
    caption.textContent = `sealed to ${n} operators. any ${t} of ${n} reveal on the cue.`;
    startOrbit();
  }

  function reveal(): void {
    el.dataset.phase = 'reveal';
    nodes.forEach((nd) => nd.el.classList.add('is-verified'));
    caption.textContent = 'the cue fired. every slot opened at once.';
    el.setAttribute('aria-label', 'revealed. every slot opened at once.');
    startOrbit();
  }

  function destroy(): void {
    stopOrbit();
    el.remove();
  }

  return { el, play, setVerified: paintVerified, reveal, destroy };
}

// The recipient side of a reveal: the secret coming back together, rather than
// the words "opening" or "firing". Two pieces:
//   - a gathering scene while the batch is frozen: the committee's shares
//     converge on the core, reconstructing the key.
//   - descramble(): the plaintext materialises out of ciphertext-like noise.
// Both are gated behind prefers-reduced-motion (static / instant under it).

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** A compact scene of `shares` motes streaming inward to reconstruct the core.
 * `shares` is clamped to a sensible range so odd committee sizes still read. */
export function createGathering(shares: number): HTMLElement {
  const n = Math.max(3, Math.min(shares || 5, 8));
  const el = document.createElement('div');
  el.className = 'rga';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'reassembling your secret from the committee shares');

  const stage = document.createElement('div');
  stage.className = 'rga-stage';

  const core = document.createElement('div');
  core.className = 'rga-core';
  core.innerHTML =
    '<span class="rga-core-face" aria-hidden="true"></span>' +
    '<img class="rga-core-logo" src="/peal-logo.png" alt="" aria-hidden="true" />';
  stage.appendChild(core);

  // Motes start on a circle and animate toward the center (via left/top, which
  // are relative to the stage, so the geometry stays correct at any size).
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = 50 + 38 * Math.cos(ang);
    const y = 50 + 38 * Math.sin(ang);
    const mote = document.createElement('span');
    mote.className = 'rga-mote';
    mote.setAttribute('aria-hidden', 'true');
    mote.style.left = `${x}%`;
    mote.style.top = `${y}%`;
    mote.style.setProperty('--sx', `${x}%`);
    mote.style.setProperty('--sy', `${y}%`);
    mote.style.animationDelay = `${(i * 0.14).toFixed(2)}s`;
    stage.appendChild(mote);
  }

  el.appendChild(stage);
  return el;
}

const NOISE = '▚▞▛▜▙▟▖▗▘▝#%&$§01xyzABCDEF';

function noiseChar(): string {
  return NOISE[Math.floor(Math.random() * NOISE.length)];
}

/** Materialise `finalText` inside `el`, resolving left to right out of noise.
 * Whitespace passes through so the shape of the message reads as it forms. */
export function descramble(
  el: HTMLElement,
  finalText: string,
  opts: { mono?: boolean } = {},
): void {
  if (opts.mono) el.classList.add('mono');
  el.setAttribute('aria-label', finalText);

  // Long payloads or reduced motion: just show it.
  if (prefersReducedMotion() || finalText.length > 320) {
    el.textContent = finalText;
    return;
  }

  const chars = [...finalText];
  const total = Math.min(1500, Math.max(650, chars.length * 26));
  const start = performance.now();

  const tick = (now: number): void => {
    const p = Math.min(1, (now - start) / total);
    const resolved = Math.floor(p * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === ' ' || c === '\n' || c === '\t' || i < resolved) out += c;
      else out += noiseChar();
    }
    el.textContent = out;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = finalText;
  };

  el.textContent = chars.map((c) => (/\s/.test(c) ? c : noiseChar())).join('');
  requestAnimationFrame(tick);
}

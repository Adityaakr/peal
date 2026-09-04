/**
 * The x402 handshake, drawn as three layers in space and animated by the real
 * thing happening.
 *
 * Why a diagram at all: the protocol is a sequence of messages between three
 * parties, and prose describing a sequence is the hardest kind of prose to
 * hold in your head. Eight numbered steps in a list still make a reader build
 * the picture themselves.
 *
 * Why it is not a video or a canned animation: it is wired to the same events
 * the payer emits while it actually pays. When the reader presses the button,
 * every beam that lights corresponds to a request that was really made, and the
 * hash that lands in it is the transaction they can open in the explorer. An
 * animation that ran the same way whether or not anything worked would be
 * decoration, and worse than none: it would look like proof.
 *
 * The 3D is CSS transforms on a perspective container. No library, no WebGL, no
 * canvas: three slabs at different depths, and one packet that moves between
 * them. It reads as depth and it costs nothing.
 */
import { esc } from '../../util';

export type StepId =
  | 'ask' | 'quote' | 'fund' | 'pay' | 'confirm' | 'retry' | 'verify' | 'serve';

interface StepDef {
  id: StepId;
  /** Which layer the message starts at and ends at. */
  from: 'you' | 'api' | 'chain';
  to: 'you' | 'api' | 'chain';
  label: string;
  detail: string;
}

/** The real sequence, matching require_payment in x402.rs step for step. */
export const STEPS: StepDef[] = [
  { id: 'ask',     from: 'you',   to: 'api',   label: 'ask',     detail: 'POST /v1/x402/rounds, no payment' },
  { id: 'quote',   from: 'api',   to: 'you',   label: '402',     detail: 'price, asset, payee, chain' },
  { id: 'fund',    from: 'you',   to: 'chain', label: 'fund',    detail: 'tempo_fundAddress, no faucet form' },
  { id: 'pay',     from: 'you',   to: 'chain', label: 'pay',     detail: 'ERC-20 transfer to the payee' },
  { id: 'confirm', from: 'chain', to: 'chain', label: 'mined',   detail: 'the transfer lands in a block' },
  { id: 'retry',   from: 'you',   to: 'api',   label: 'retry',   detail: 'X-PAYMENT: base64({txHash})' },
  { id: 'verify',  from: 'api',   to: 'chain', label: 'verify',  detail: 'receipt, amount, payee, age' },
  { id: 'serve',   from: 'api',   to: 'you',   label: '200',     detail: 'the work, plus the receipt' },
];

const LAYERS = [
  { id: 'you',   title: 'your code',  sub: 'a browser tab, an agent, a server' },
  { id: 'api',   title: 'peal',       sub: 'the same handlers as the free API' },
  { id: 'chain', title: 'tempo',      sub: 'where the payment settles' },
] as const;

export function sceneHtml(): string {
  return `
  <div class="x3" id="x3">
    <div class="x3-stage">
      ${LAYERS.map(
        (l) => `
        <div class="x3-layer x3-${l.id}" data-layer="${l.id}">
          <div class="x3-slab">
            <span class="x3-layer-title">${esc(l.title)}</span>
            <span class="x3-layer-sub">${esc(l.sub)}</span>
          </div>
        </div>`,
      ).join('')}
      <div class="x3-beam x3-beam-up" data-beam="you-api"></div>
      <div class="x3-beam x3-beam-down" data-beam="api-chain"></div>
      <div class="x3-packet" id="x3-packet"><span></span></div>
    </div>
    <ol class="x3-steps" id="x3-steps">
      ${STEPS.map(
        (s, i) => `
        <li class="x3-step" data-step="${s.id}">
          <span class="x3-n">${i + 1}</span>
          <span class="x3-label">${esc(s.label)}</span>
          <span class="x3-detail">${esc(s.detail)}</span>
          <span class="x3-value" data-value="${s.id}"></span>
        </li>`,
      ).join('')}
    </ol>
  </div>`;
}

/**
 * Drives the scene. Nothing here fetches or decides: the page calls `enter` as
 * the payer reports what it is doing, so the diagram cannot get ahead of the
 * work it is describing.
 */
export class Scene {
  private packet: HTMLElement | null;
  private idle: number | undefined;

  constructor(private readonly root: HTMLElement) {
    this.packet = root.querySelector('#x3-packet');
  }

  /** Light one step, optionally with a real value to show beside it. */
  enter(id: StepId, value?: string): void {
    this.stopIdle();
    const step = STEPS.find((s) => s.id === id);
    if (!step) return;

    for (const li of this.root.querySelectorAll('.x3-step')) {
      const at = (li as HTMLElement).dataset.step as StepId;
      const order = STEPS.findIndex((s) => s.id === at);
      const here = STEPS.findIndex((s) => s.id === id);
      li.classList.toggle('is-on', at === id);
      li.classList.toggle('is-done', order < here);
    }

    for (const layer of this.root.querySelectorAll('.x3-layer')) {
      const which = (layer as HTMLElement).dataset.layer;
      layer.classList.toggle('is-active', which === step.from || which === step.to);
    }

    if (value !== undefined) {
      const slot = this.root.querySelector(`[data-value="${id}"]`);
      if (slot) slot.textContent = value;
    }

    if (this.packet) {
      this.packet.dataset.at = step.to;
      this.packet.dataset.dir = step.from === step.to ? 'self' : 'move';
      this.packet.classList.add('is-live');
      const label = this.packet.querySelector('span');
      if (label) label.textContent = step.label;
    }
  }

  /** Everything succeeded: hold the last state rather than resetting, so the
   *  reader can look at what happened. */
  finish(): void {
    this.stopIdle();
    for (const li of this.root.querySelectorAll('.x3-step')) li.classList.add('is-done');
    this.root.classList.add('is-complete');
  }

  fail(): void {
    this.stopIdle();
    this.root.classList.add('is-failed');
  }

  reset(): void {
    this.root.classList.remove('is-complete', 'is-failed');
    for (const li of this.root.querySelectorAll('.x3-step')) {
      li.classList.remove('is-on', 'is-done');
    }
    for (const slot of this.root.querySelectorAll('.x3-value')) slot.textContent = '';
    for (const layer of this.root.querySelectorAll('.x3-layer')) layer.classList.remove('is-active');
    this.packet?.classList.remove('is-live');
  }

  /**
   * A slow loop before anybody presses anything, so the diagram reads as a
   * sequence rather than a static picture. Marked so it cannot be mistaken for
   * a real run: no values appear, and the first real step clears it.
   */
  startIdle(): void {
    if (this.idle !== undefined) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 0;
    this.root.classList.add('is-idle');
    const tick = (): void => {
      const step = STEPS[i % STEPS.length]!;
      for (const li of this.root.querySelectorAll('.x3-step')) {
        li.classList.toggle('is-on', (li as HTMLElement).dataset.step === step.id);
      }
      for (const layer of this.root.querySelectorAll('.x3-layer')) {
        const which = (layer as HTMLElement).dataset.layer;
        layer.classList.toggle('is-active', which === step.from || which === step.to);
      }
      if (this.packet) {
        this.packet.dataset.at = step.to;
        this.packet.classList.add('is-live');
        const label = this.packet.querySelector('span');
        if (label) label.textContent = step.label;
      }
      i += 1;
      this.idle = window.setTimeout(tick, 1100);
    };
    tick();
  }

  stopIdle(): void {
    if (this.idle !== undefined) {
      window.clearTimeout(this.idle);
      this.idle = undefined;
    }
    this.root.classList.remove('is-idle');
  }
}

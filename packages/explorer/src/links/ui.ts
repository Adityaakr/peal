// Small pieces shared by the Peal Private Links pages (dashboard, checkout).
import { esc } from '../util';

/** A deterministic identicon for an address: three soft colour fields on a
 * disc, hue and placement from the address bytes, so the same wallet always
 * gets the same mark and no two look alike at a glance. */
export function avatar(address: string, size = 28): string {
  const hex = address.replace(/^0x/, '').toLowerCase().padEnd(40, '0');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const h1 = (n(0) * 360) / 255;
  const h2 = (h1 + 140 + (n(2) % 80)) % 360;
  const h3 = (h1 + 220 + (n(4) % 80)) % 360;
  const cx = 8 + (n(6) % 16);
  const cy = 8 + (n(8) % 16);
  const dx = 16 + (n(10) % 12);
  const dy = 20 + (n(12) % 8);
  const id = `av${hex.slice(0, 8)}`;
  return `<svg class="pla-avatar" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <defs><clipPath id="${id}"><circle cx="16" cy="16" r="16"/></clipPath></defs>
    <g clip-path="url(#${id})">
      <rect width="32" height="32" fill="hsl(${h1.toFixed(0)} 70% 62%)"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="hsl(${h2.toFixed(0)} 75% 60%)" opacity="0.9"/>
      <circle cx="${dx}" cy="${dy}" r="12" fill="hsl(${h3.toFixed(0)} 80% 66%)" opacity="0.85"/>
    </g>
  </svg>`;
}

/** First letter up, for messages the session module writes in lowercase. */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Something is running: a spinner, the step, and a moving bar. */
export function busyBanner(text: string): string {
  return `<div class="pla-busy" role="status" aria-live="polite"><span class="pla-spinner" aria-hidden="true"></span><span class="pla-busy-text">${esc(cap(text))}</span><span class="pla-busy-bar" aria-hidden="true"></span></div>`;
}

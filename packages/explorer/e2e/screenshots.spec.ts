// Screenshots of every Peal Links page at phone, tablet and desktop widths,
// written under docs/peal-links/evidence/<phase>/ for inspection. The phase
// is taken from SHOTS_DIR so later phases keep their own set.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const OUT = process.env.SHOTS_DIR ?? join(here, '..', '..', '..', 'docs', 'peal-links', 'evidence', 'phase-b');
const WIDTHS: Array<[string, number, number]> = [
  ['phone', 390, 844],
  ['tablet', 820, 1180],
  ['desktop', 1280, 900],
];
const PAGES: Array<[string, string]> = [
  ['landing', '/#/bonsai'],
  ['app', '/#/bonsai/app'],
  ['pay', '/#/pay/' + (process.env.PAY_ID ?? 'abcdefghijklmnopqrstuvwx')],
  ['pay-bad-id', '/#/pay/not-a-request'],
  ['home', '/'],
  ['mempool-landing', '/#/mempool'],
  ['developers', '/developers'],
];

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const [name, path] of PAGES) {
  for (const [label, width, height] of WIDTHS) {
    test(`${name} at ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(600);
      // Scroll through the page so scroll-revealed sections are shown, the
      // way a reader sees them, then capture from the top.
      await page.evaluate(async () => {
        const step = Math.max(300, window.innerHeight - 100);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 90));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(OUT, `${name}-${label}.png`), fullPage: true });
      // No horizontal overflow at any width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${name} at ${label}`).toBeLessThanOrEqual(1);
      expect(errors, `page errors on ${name}`).toEqual([]);
    });
  }
}

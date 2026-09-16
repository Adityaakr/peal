# 0007: Hash routes, with clean-path aliases through the existing page table

Date: 2026-09-16. Status: accepted.

## Decision
- The explorer routes on the URL fragment (`packages/explorer/src/main.ts`). Peal Links keeps that: `#/bonsai` (landing), `#/bonsai/app` (dashboard), `#/pay/<requestId>` (checkout).
- Clean paths `/bonsai`, `/bonsai/app` and `/pay/<id>` are added to the page table (`PAGE_PATHS` in `main.ts` and `PAGES` in `crates/bte-coordinator/src/pages.rs`) so a pasted `peal.network/bonsai` boots the app at the right page, exactly as `/developers` does today. The Caddy edge already serves the shell for any path.
- Navigation: one "payments" entry in the existing header menu.

## Why
- The hosting serves `index.html` for unknown paths, but the router and every shared link in the wild are fragment-based; switching to history routing would be a site-wide change the spec forbids for a product section.
- Refresh and deep links survive because both the fragment and the clean path resolve to the same render.

## Consequences
- Checkout pages carry `noindex` and `referrer: no-referrer` meta set at render time; the request id never appears in analytics (there are none on these routes).

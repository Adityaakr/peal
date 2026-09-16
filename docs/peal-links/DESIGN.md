# Peal Links design notes

What the product looks like, why, and where each element lives. Screenshots inspected during the build are under `evidence/phase-b/` and `evidence/phase-c/`.

## Reuse of Peal's system

- Tokens from `packages/explorer/src/style.css`: accent `#2563eb` (hover `#1d4ed8`), text `#111827`, muted `#6b7280`, border `#e5e7eb`, surface `#f9fafb`, the site-wide sky gradient on `html`. No new brand colours; nothing green for Bonsai.
- Type: Josefin Sans 400 for display (`.pl-h1`, `.pl-h2`, amounts), DM Sans for body, the existing monospace stack for identifiers.
- Chrome: the existing header, logo and burger menu; one new menu entry, "payments". The landing does not bring its own navbar.
- Components: pill buttons in the style of the mempool landing (`.ml-btn`), hairline cards, status chips, the `.skeleton` loading rows, `.scroll-reveal` sections through `mountScrollReveal`.
- All Peal Links styles are prefixed `.pl-` in `packages/explorer/src/links.css` and imported by the three pages only.

## Pages

| Route | File | Purpose |
|---|---|---|
| `#/bonsai` (also `/bonsai`) | `pages/bonsai-landing.ts` | Product landing: hero, illustrative checkout (fictional data, labelled), how it works, use cases, observer matrix, developer example from the real crate, FAQ, attribution |
| `#/bonsai/app` (also `/bonsai/app`) | `pages/bonsai-app.ts` | Account setup and unlock, balances per asset domain, requests, incoming receipts, withdrawals, activity, ledger, backup export and restore |
| `#/pay/<id>` (also `/pay/<id>`) | `pages/pay.ts` | Public checkout: manifest verified in wasm, exact amount, payee with its assurance level, funding from the connected wallet, proving progress, honest terminal states |

## Principles applied

- **Say only what the code does.** Every claim on the landing page is backed by a file in this repository; the trust model (local setup, single-node ledger, committee-attested bridge, single-process signer fixture) is printed on the app and in the withdraw dialog.
- **Amounts are integers until display.** `links/format.ts` formats base units with the asset's decimals and parses typed amounts back without floats.
- **States are real.** A pending status chip animates only while a real operation runs; proving shows "about 7 s" from measurement, never a percentage. Payment acceptance, receipt delivery and the receiver's claim are separate states and worded as such.
- **No dead controls.** A button that cannot work is disabled with a title saying why, or not rendered.
- **Privacy on checkout.** `noindex` and `referrer: no-referrer` meta are set on the checkout route; request ids and amounts never reach analytics (there are none on these routes).

## Responsive behaviour

- Tested at 390, 820 and 1280 px (`packages/explorer/e2e/screenshots.spec.ts` asserts no horizontal overflow at each).
- The hero becomes a single column under 820 px; the three-column grids stack under 720 px; the observer matrix becomes labelled cards under 640 px; the checkout card is capped at 480 px and full-width on phones.
- Touch targets are at least 44 px high (`.pl-btn`, inputs).

## Motion and accessibility

- Transitions of 100 to 240 ms on buttons and dialogs; scroll-reveal entrances through the existing helper; the pending dot pulses at 1.2 s. All of it is disabled under `prefers-reduced-motion`.
- Visible focus rings come from the site's `:focus-visible` rule. Dialogs are native `<dialog>` elements opened with `showModal()`, so focus is trapped and Escape closes them. Form errors are printed next to the form with `role="alert"`; status lines use `role="status"`.
- Colour contrast: body text `#374151` on the light surfaces exceeds 7:1; muted `#6b7280` on white is 4.6:1; chip colours use the site's red and green text tokens.

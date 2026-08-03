# Brand: Peal

_Status: active_ (renamed from bte 2026-07-07; design spec from the original build prompt)

## Naming

- Product name: **Peal**. Domain: peal.network. Site title: **Peal Network**.
- The explorer surface is titled **Peal Network**.
- Logo: the teal network mark at packages/explorer/public/peal-logo.png (also the
  favicon). Logo teals are LOGO-ONLY colors, never UI
  accents; the UI accent stays #2563eb.
- Identity line: "peal — the programmable disclosure network." (user-approved
  em-dash exception, 2026-07-07; everywhere else the no-em-dash rule holds)
- Headline: "your users commit. the network reveals."
- Supporting line: "commit-reveal without the second transaction."
- Speed line: "secrets that open themselves add them to your dapp in minutes."
- Description: "secrets that open themselves add them to your dapp in minutes.
  seal data to a cue (a time, a block, a condition, an event) and when it
  fires, the whole batch opens at once: no second transaction, no selective
  reveal. built on batched threshold encryption; decentralized operator
  committee on the roadmap."
- Internal names stay: bte-* crates, bte-sdk on npm, /v0 API, wire magic BTE0.
  Peal is the product; bte is the plumbing.

## Voice

Sentence case everywhere, including headings. Short, declarative, technical,
no hype, no emoji in UI, **no em-dashes anywhere in UI copy** (use periods or
commas). No trust banner in the UI (removed 2026-07-07); the v0 trust caveat
lives in the README and docs instead.

## Color

| token | value | use |
|---|---|---|
| background | sky gradient `#dcebfa -> #eaf3fc -> #f6f9fd` (on html) | page, all routes (2026-07-08; was plain white) |
| text | `#111827` | body |
| muted | `#6b7280` | captions, secondary |
| border | `#e5e7eb` | hairlines, cards |
| accent | `#2563eb` | THE single accent: links, focus rings, frozen state, primary buttons |
| green | `#16a34a` | revealed / success only |
| red | `#dc2626` | stalled / rejected / corrupt only |

No decorative gradients beyond the page-background sky wash, no shadows heavier than `0 1px 2px rgb(0 0 0 / 0.05)`, no dark
mode (white is part of the identity).

## Typography

- UI: Satoshi via Fontshare (400/500/700), system-ui fallback.
- Protocol article headings: Inter 600/700 via Google Fonts, system sans-serif fallback.
- Hashes, ids, numbers: `ui-monospace` stack; `tabular-nums` globally.
- Generous whitespace over boxes; hairline borders over fills.

## Motion

Purposeful only: state transitions (reveal flip, share arrival) and micro
feedback. Durations 100-300 ms, ease-out on enter, ease-in on exit, all
gated behind `prefers-reduced-motion: no-preference`.

# Peal browser extension — live reveal countdowns

Turns a Peal seal link into a live ticking countdown, in place, wherever it is
posted. Built for launches and announcements on X, and it works on any site.

```
v2 ships when this opens 👀  peal.network/#/s/bPGLBTUVOZ0

  ┌──────────────────────────────────────────────────────┐
  │ 🔒 sealed ●                                    peal  │
  │                                                      │
  │              nobody can read this yet                │
  │                    9m 57s                            │  ← ticks every second
  │                  until it opens                      │
  │                                                      │
  │ ──────────────────────────────────────────────────── │
  │ opens 16:41 · today    not the sender, not the ops…  │
  └──────────────────────────────────────────────────────┘
              16:9, full post width — an X media embed
```

**Shaped like X's media.** 16:9, full width of the post column, the same 16px
corner radius, capped at 560px. It should read as the post's media rather than
a widget stapled underneath it. The countdown is centred as the hero because
that is the thing that stops a scroll. Type scales with the card via container
queries, so a narrow column and a wide one both look deliberate.

**Light only, always.** `brand.md:45` is explicit that there is no dark mode
because white is part of the identity, and against X's dark timeline a light
card is exactly what gets looked at. Palette is the brand sky gradient with
`#2563eb` as the single accent (`brand.md:36,40`).

**The caption strip** carries the reveal time in the viewer's own timezone —
`opens 16:41 · today`. The countdown says how long; this says *when*, which is
what someone needs to set a reminder or plan around it. It turns green with an
open shackle the moment the seal reveals, no refresh.

Copy is per state — `nobody can read this yet` while sealed, `opening right now`
during the freeze, `the wait is over` once it opens. It lives in `paint()` in
`src/content.js`; the card cannot know what the announcement says, so the lines
stay true for any seal.

## Why an extension, and not a link preview

X's in-timeline cards are static images. Twitterbot does not run JavaScript,
animated GIFs are flattened to their first frame, and there is no video or
script in a card. So a genuinely live counter in the timeline is not achievable
through Open Graph tags — a content script is the only mechanism that can do it.

The trade is honest: **only people who install this see the countdown.**
Everyone else sees a plain link. If you want something for the other 99%, that
is the Open Graph card, which is a separate piece of work (a static branded
image plus a server-rendered "reveals in 2h 14m" title).

## Why it only became possible now

On X, every `href` is rewritten to `t.co`, so the destination is not in the
link's `href` — it is in the text X renders inside the anchor, and X truncates
that text with an ellipsis when it is long.

A public short link is 36 characters and survives intact. The 119-character form
Peal emitted before short share codes did not: X would cut it off mid-hash and
the extension would have nothing to work with. The parser refuses a truncated
link rather than guessing at the missing characters, so the old format simply
produces no card.

## Install (unpacked)

Chrome, Edge, Brave, Arc — anything Chromium, manifest v3:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` directory
4. Open X and scroll past a post with a Peal link

Firefox needs a `browser_specific_settings` key and uses a slightly different
service-worker story; not wired up yet.

## What it touches

| surface | why |
|---|---|
| `x.com`, `twitter.com` | the launch/announcement case |
| `warpcast.com`, `farcaster.xyz` | same treatment on Farcaster clients |
| every other http(s) site | blogs, docs, Discord web — one generic matcher |
| `peal.network` itself | **excluded** — the app already shows its own countdown |

Network access is limited to `https://peal.network/*` via `host_permissions`.
It reads two public endpoints, `GET /v0/seals/:code` and
`GET /v0/conditions/:id`, and writes nothing.

## The privacy rule

A private seal's link ends in an AES-128-GCM key that lives only in the URL
fragment and is never sent to any server. This extension must not be the thing
that breaks that.

So the key is dropped at the parser boundary. `parseSealLink` returns a lookup
handle — a share code or a condition id — and nothing else. The background
worker, the network, and the cache never see the key, because it is discarded
before any of them are reached. The countdown does not need it: `fires_at` comes
from the public condition.

`extension/test/parse.test.js` asserts this directly, and the headless run
asserts it again at the network layer by checking that no outbound request
contains the key or any 8-character prefix of it.

## Layout

```
manifest.json      MV3, three content-script blocks, one host permission
src/parse.js       link recognition; drops the key. Plain script, node-testable
src/content.js     DOM scan, card injection, the one-second tick
src/background.js  fetch proxy (X's CSP blocks a content-script fetch), caching
src/card.css       the card; scoped, theme-aware, no external assets
test/parse.test.js parser tests, incl. the privacy invariant
test/fixture.html  dev harness — X-shaped markup, stubbed chrome.runtime
```

No build step. The extension is plain JavaScript so `Load unpacked` works
straight from the repo with nothing to compile first.

## Developing

Run the parser tests:

```sh
node extension/test/parse.test.js
```

Open `extension/test/fixture.html` in a browser to see the card render and tick
without installing anything — it runs the real `parse.js` and `content.js`
against X-shaped markup, with `chrome.runtime` stubbed to call the live
coordinator. It includes a synthetic pending seal so the countdown is
exercisable without waiting on a real one, plus the cases that must produce
**no** card: a truncated link, and an unrelated one.

After changing anything under `src/`, hit reload on the extension card in
`chrome://extensions` — content scripts are not hot-reloaded.

### Notes for whoever picks this up next

- The card is inserted after the link's nearest block-level ancestor, so it
  lands under the post text rather than mid-sentence. X's DOM is obfuscated and
  changes often; this deliberately avoids depending on any X class name.
- Timelines are virtualised, so a one-shot scan sees almost nothing. A debounced
  `MutationObserver` handles posts mounting during scroll.
- Once a countdown passes zero the coordinator still has to freeze the batch and
  gather shares, so the card re-checks after a few seconds instead of sitting on
  "any moment" forever.
- Lookups are deduped and cached in the worker: the same seal in twenty posts
  costs one request.

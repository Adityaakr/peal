# bte — project model
<!-- updated 2026-08-03 by prism-understand (Vara.eth evaluation: NO for now, measured) -->
<!-- updated 2026-07-14 by prism-understand (verification story: the reveal check was circular) -->
<!-- updated 2026-07-12 (timing trust hole; Railway volume fix; landing prompt handoff) -->
<!-- updated 2026-07-09 by prism-understand (OG/social-card feasibility for shared links) -->
<!-- updated 2026-07-07 by prism-understand (share-link recipient flow + engagement audit) -->

## What this is
Reveal-later encryption network ("seal now. reveal on cue.") on commonware's
batched threshold encryption. Built end to end 2026-07-06/07, phases 0-8 all
green. Contract: `spec/index.md`. Status + gates: `PROGRESS.md`, `REPORT.md`.

## Architecture (verified)
- `crates/bte-crypto` is the ONLY crate touching group elements; it wraps
  simple-bte pinned at git rev `147a0878` (Cargo.toml workspace dep). Payload
  path is the FO module (`fo.rs`), NOT the Schnorr/G_T path — see
  spec/API-MAP.md for the exact function map.
- Coordinator: axum /v0 + rusqlite (single Mutex<Connection>), engine tick
  500ms (`engine.rs:tick`), cross-terms cached in memory, recomputed after
  restart (`finalize_batch`).
- Nodes: outbound-only pollers, argon2id+ChaCha20 keystores
  (`bte-node/src/keystore.rs`).
- SDK: wasm inlined as base64 (`packages/sdk/scripts/build.mjs`), two wasm
  chunks (seal / verify). Anchor helpers are dependency-free (precomputed
  selectors, raw eth_call).

## Invariants (do not break)
- Positions: real cts sort by ct_hash, dummies fill the tail — a pure
  function of the real ct set (invariant 6 test).
- Wire types all start `BTE0` + type byte; golden files in
  `crates/bte-crypto/tests/golden/` (regenerate only with BTE_BLESS=1 and a
  version bump).
- KEM header and shares are exactly 48 bytes (tested).
- `/v0/reveals/:id` must 404 before reveal (invariant 4 test greps the db
  for plaintext bytes).
- Rejected shares are stored flagged and NEVER count toward t.

## Verification model (mapped 2026-07-14 — read this before touching any "verify" UI)
What is REAL vs what only looks real. The distinction is the whole point of the product.

- **The chain is reachable from the browser.** `rpc.moderato.tempo.xyz` answers with
  `access-control-allow-origin: *` (tested live). No relayer, no coordinator, no chain
  lib needed: `packages/sdk/src/anchor.ts:127` already does a raw `eth_call` over
  `fetch`. This is the only non-circular source the page has.
- **On-chain anchors that exist today:**
  - `PealMempool.settledRoot(bytes32)` public mapping (`contracts/src/PealMempool.sol:31`)
    — `eth_call`-readable. `executeBatch` recomputes the tree on-chain with the sha256
    precompile and reverts on `RootMismatch` (`PealMempool.sol:71-72`).
  - `Sealed(conditionId, ctHash, from)` — **all three args indexed**
    (`PealMempool.sol:42`), so `eth_getLogs` yields the ct_hash set committed BEFORE
    reveal, block-timestamped. `commitSealed` writes no storage (`PealMempool.sol:58-60`);
    the log is the only record.
  - `BatchExecuted(conditionId, merkleRoot, realCount)` (`PealMempool.sol:43`).
- **`BteAnchor.sol` is NOT deployed.** `contracts/script/` has only `DeployMempool.s.sol`,
  and `deployments/42431.json` carries no anchor address. The SDK's `verifyAnchor`
  (`anchor.ts:116`) therefore targets a phantom contract — same mapping shape as
  `settledRoot`, so it works once the selector is repointed.
- **The trap that was shipped:** `condition.ts:151-152` compared the locally recomputed
  root against `r.merkle_root` — a field from the SAME `/v0/reveals/:id` JSON as the
  plaintexts it recomputed from. Self-consistency, not integrity. Any "verify" that
  reads its expected value from the coordinator is theatre. **Anchor every comparison to
  a value the coordinator cannot retcon.**
- **Free local checks nobody was doing:** dummy payloads carry a literal
  `b"BTE_DUMMY_V0:"` prefix (`bte-crypto/src/lib.rs:450`), so post-reveal
  `is_dummy == payload.startsWith(prefix)` is checkable from public data; likewise
  positions are deterministic (reals ascending by ct_hash, dummies a sorted tail —
  `engine.rs:133-146`).

### Known holes (do not let the UI claim otherwise)
- **`isReal` is not in the merkle leaf.** The leaf is `sha256(le32(pos) || payload)`
  (`merkle.rs:9-14`, `PealMempool.sol:98`). `executeBatch` skips `!isReal` slots
  (`PealMempool.sol:77,83`) AFTER the root check passes, so flipping a real order to
  dummy preserves the root and silently censors it. Client-side the dummy-prefix check
  catches it; the contract fix is ~3 lines + a redeploy.
- **`executeBatch` is coordinator-only** (`PealMempool.sol:67`). The chain proves
  immutability and ordering, NOT coordinator honesty. Say exactly that in the copy.
- **Nothing binds a ciphertext to a committee.** `ct0 = [k]_1` is independent of `ek`
  (`bte-crypto/src/lib.rs:169-174`). Not fixable via API surface; it is the scheme.
  `params_digest` from `/v0/committees/:id` is circular AND bugged (`api.rs:674` returns
  column 0, i.e. the id).
- **Share bytes are never served.** `get_reveal` selects only booleans + timestamps
  (`api.rs:548`); `share_blob` is written (`api.rs:513`) and never read out, and
  `/v0/work` filters `finalized_at IS NULL` (`api.rs:381`) so a revealed condition's
  headers are unreachable. So wasm `verifyShare` (`sdk/src/verify.ts:24`) — the only
  cryptographic t-of-n proof available — is IMPOSSIBLE from the browser until the
  coordinator serves `share_b64` + `headers_b64`.
- **`ct_hash` is coordinator-asserted.** `sdk/src/index.ts:200-207` anchors whatever
  hash the coordinator echoes back; the browser never re-derives it, even though
  `bte-wasm` exports `ct_hash(sealed)->hex` (`crates/bte-wasm/src/lib.rs:53-58`), the
  SDK loads it (`wasm.ts:33`), and the browser still holds `sealedB64`. Zero call sites.
- **Most dashboard conditions have NO chain anchor.** `tag == 'mempool'` is set only at
  `mempool.ts:417`; capsule/round conditions (`playground.ts:469-501`) are never
  committed on-chain. `settledRoot` returns `0x0` for them — never render that as a pass.

## Gotchas (hard-won)
- ark-std 0.6 re-exports rand 0.8; simple-bte also deps rand 0.9 (unused by
  its lib API). Use `bte_crypto::rand` / `bte_crypto::os_rng()` downstream —
  never a direct rand dep (version split bites).
- wasm builds need `.cargo/config.toml` cfg `getrandom_backend="wasm_js"`
  (getrandom 0.3 via rand 0.9) AND getrandom 0.2 "js" feature.
- Docker runtime user needs /data + /ceremony chown'd in the image (named
  volumes inherit image ownership).
- pnpm 11 blocks build scripts; `allowBuilds: esbuild: true` in
  pnpm-workspace.yaml.
- Shell cwd persists between Bash calls in this harness; watch relative paths.
- Piping `just …` through `tail` masks exit codes — verify demo results via
  API state, not pipe tails.

## Docs
- Standalone protocol article: docs/protocol.html (self-contained HTML, brand
  tokens inline, SVG architecture diagram). Same content spine as #/protocol;
  update BOTH when the protocol or SDK surface changes.
- Code-side deep-dive: docs/how-peal-is-built.html (self-contained HTML, Inter +
  JetBrains Mono, brand tokens inline, hand-authored SVG architecture diagram).
  Teaches the whole build crate-by-crate: bte-crypto (7-fn lifecycle), engine
  state machine, node/keystore, wasm bridge, SDK, merkle+anchor, trust trade-offs.
  Grounded 2026-07-08 in lib.rs/engine.rs/api.rs/merkle.rs/node/cli/wasm/sdk.
  Keep in sync when the crate surface or trust model changes.
- In-app protocol reference at #/protocol (packages/explorer/src/pages/protocol.ts,
  nav in index.html): overview, use cases, lifecycle, cryptography (wire, FO,
  punctured setup, pipelined recovery, merkle commitment), private seals,
  architecture, production posture, integration (incl. tags), trust model.
  Grounded in spec/index.md + engine.rs/merkle.rs; keep in sync when the
  protocol or SDK surface changes. Styles live under .protocol-* in style.css.
  Restyled 2026-07-08 to match the philosophy design system: Josefin Sans
  400/500 headings, DM Sans body, hairline section separators, scroll-reveal
  motion on header + all sections via the shared src/reveal.ts helper
  (mountScrollReveal; .scroll-reveal/.is-visible classes in style.css).
- Landing page at #/ (packages/explorer/src/pages/landing.ts): light centered
  hero (Josefin/DM Sans, soft sky gradient), "Seal now. / Reveal on cue."
  headline, a seal-prompt pill that hands off to #/app, dark/light pill CTAs,
  and the real app screenshot (public/app-preview.png, regenerate by
  screenshotting peal.network/#/app at 2000px) in a CSS browser frame rising
  from the fold. Staggered blur-fade entrance. The EXPLORER moved to #/app
  (main.ts routes; unknown hashes still fall through to the explorer).
  body.landing-page hides the standard site header and unclamps main.
  History: v1 Spline 3D hero, v2 HLS video hero (both replaced 2026-07-08).
- Philosophy manifesto at #/philosophy (packages/explorer/src/pages/philosophy.ts,
  route in main.ts, sole visible header nav link — network/protocol/code links
  are hidden in index.html, 2026-07-08 user request). Copy is user-authored
  verbatim (epigraph + 6 tenets + "what this unlocks" + "seal now. reveal on
  cue." sign-off). Redesigned 2026-07-08 per user: sentence-case grammar
  (capitals restored), Josefin Sans 300-500 headings ("not too bold"), DM Sans
  body (both via Google Fonts in index.html), centered header, 64px numeral
  gutter, hairline tenet separators, scroll-reveal motion (blur 14px + rise +
  fade, 700ms ease-out; above-fold blocks stagger in on load 110ms apart,
  below-fold via IntersectionObserver; reduced-motion shows all instantly).
  Styles under .philosophy-* in style.css. NOTE: this page intentionally
  deviates from brand.md typography (Satoshi/Inter) at user request.

## Decision log
- 2026-07-07: product renamed OPEN then Peal (peal.network) same day;
  explorer is "Peal Explorer", identity "the guaranteed reveal network",
  headline "commit-reveal without the second transaction.", speed line "add
  fair reveals to your dapp in minutes." Display strings only (brand.md
  Naming section); bte-* crates, bte-sdk, /v0 API, BTE0 wire magic unchanged.
- 2026-07-07: private seals: AES-128-GCM layer over capsule payloads, key in
  the share-link fragment only (packages/explorer/src/privacy.ts, BTEP1 wire
  prefix). Default ON for time capsules; bids/votes stay public by design.
- 2026-07-07: FO transform as DEM + CCA (spec allowed it; DEVIATIONS #1/#2).
- 2026-07-07: per-slot validity via bandwidth-optimized hints `[k_i]_1==ct0`
  (public API only) so mauled cts never poison a batch.
- 2026-07-07: revealRoot tx sent by key-holder script, coordinator stays
  chain-free (DEVIATIONS #6).
- 2026-07-07: explorer needed hand-rolled CORS in api.rs (no new deps).

## Frontend (playground, 2026-07-07)
- Explorer is a playground: seal in-browser via bte-sdk wasm (packages/explorer/src/playground.ts),
  live share dots from `verified_shares` per batch (api.rs get_condition), reveal flip.
- brand.md at repo root is the design source of truth (white, Satoshi, #2563eb, sentence case, no em-dashes).
- SDK gotcha FIXED: `fetch` must be bound to globalThis (bare reference = Illegal invocation in browsers).
- Dockerfile.web builds the pnpm workspace in 3 stages (wasm-pack -> pnpm -> caddy); .dockerignore added.
- Browser e2e pattern: playwright script in scratchpad drives seal->reveal with screenshots; port 8080
  may be held by the user's other projects (cusp-fi vite) — use a compose port override (18080) for tests.

## Condition tags + round segregation (2026-07-07)
- conditions carry an optional `tag` TEXT column (db.rs schema + ALTER
  migration in db.rs open()); create_condition validates <=32 chars of
  [a-z0-9:_-] (api.rs); returned by list/get. SDK condition() takes tag.
- Playground tags: `round:bid`, `round:vote` (shared, joinable), `capsule`
  (never joined). findOpenRound(tag) matches tag exactly — untagged/legacy
  conditions are never joined (playground.ts). Round length: first sealer's
  #pg-round-secs select (30s..1h) sets it; joiners inherit.
- INVARIANT: never join a condition whose tag you did not create for that
  purpose — joining someone's capsule strands the entry until the capsule
  fires (the original bug).

## Dummy padding (mapped 2026-07-07)
- WHY: B=64 is baked into the ceremony CRS (punctured powers-of-tau, FFT domain,
  spec/index.md:32,39-42); every batch MUST be exactly B slots, so the
  coordinator pads with self-sealed dummies at freeze (engine.rs:135-143).
- Each dummy is a REAL FO ciphertext sealing "BTE_DUMMY_V0:" + 16 random bytes
  (bte-crypto/src/lib.rs:449-455); unique ct_hash per batch; committed in the
  merkle root with all slots (engine.rs:407-430); operators do real work on them.
- Reveal API exposes per slot ONLY: position, ct_hash, is_dummy, valid,
  payload_b64 (engine.rs:19-25, api.ts:50-56). Dummy rows are visually
  identical except position/hash — the expandable 63-row table in
  condition.ts boardTable duplicates what the slot grid already shows.
- Classification logic (corrupt/dummy/private/real) is duplicated between
  slotGrid (condition.ts:211-219) and slotRow (condition.ts:234-245).

## Share-link recipient flow (mapped 2026-07-07)
- Link format: `${origin}${pathname}#/s/<conditionId>/<ctHash>` (packages/explorer/src/playground.ts:70);
  router regex requires exact 64-hex ctHash (packages/explorer/src/main.ts:16).
- Recipient page packages/explorer/src/pages/seal-view.ts: 2s status poll + 1s countdown tick
  (seal-view.ts:99-100); reveal detected purely by `status === 'revealed'` (seal-view.ts:69), then
  getReveal + slot match by ct_hash (seal-view.ts:75).
- Deployment: hash routes never reach the server; Caddy is static try_files fallback
  (docker/Caddyfile:11-15) so per-link OG previews are impossible without a server route.
- Coordinator: CORS `*` (api.rs:70), rate limit 50 rps / 400 burst per IP (state.rs:16) — polling
  is a non-issue. NO push machinery anywhere (no WS/SSE/webhook/email); only pull. The one hook
  point for future push is the reveal write in engine.rs finalize_ready.
- Engagement primitives ABSENT (all confirmed by grep): document.title never updated, no
  favicon/OG/manifest in index.html, no service worker/Notification API, no localStorage
  (no "my seals" persistence), no visibilitychange handling (background tabs throttle the
  2s poll to ~1/min, so "opens by itself" is unreliable when hidden), no sender name/label
  (conditions table has no creator/memo column, db.rs:16-25; kicker hardcoded seal-view.ts:13).

## Social / OG link cards — feasibility (mapped 2026-07-09)
- ASK: show a LIVE ticking reveal timer inside an X/Twitter link preview when a Peal link is pasted.
- EXTERNAL VERDICT: impossible on X. In-timeline cards are a static image (twitter:image/og:image,
  JPG/PNG/WebP; GIF flattened to first frame; NO JS/video/animation; Twitterbot doesn't run JS).
  Best achievable = a dynamic PNG "reveals in Xh Ym" SNAPSHOT frozen at scrape time; X caches it
  ~7 days and doesn't re-scrape on a schedule, so it can go stale (show a card that reads sanely
  after the reveal too). Live in-feed refresh is a Farcaster Frame capability, not X.
- CURRENT STATE: pure Vite SPA, no SSR/edge. Single static index.html for all routes
  (docker/Caddyfile try_files → /index.html). Meta tags are global + static in
  packages/explorer/index.html:6-13 — has og:title/description + `twitter:card=summary` (not
  large_image) and NO og:image/twitter:image at all. No OG-image/screenshot/satori/resvg code
  anywhere (grep-confirmed). Coordinator serves JSON only under /v0.
- STRUCTURAL BLOCKER (the real one): all shareable ids live in the URL FRAGMENT (after `#`),
  which scrapers never receive. Router is hash-based (main.ts:13-38). Share link builder
  `sealLink()` playground.ts:92-95 → `…#/s/<conditionId>/<ctHash>/<shareKey>`. So an edge/scraper
  literally can't tell which seal a link points to.
- PRIVACY CONSTRAINT: the trailing `<shareKey>` fragment segment is the AES-128-GCM decryption key
  (privacy.ts:26-38, "travels ONLY in the hash fragment, never sent to any server"). Moving seal
  identifiers to a server-visible path to enable OG would LEAK the key. Per-SEAL private-capsule OG
  is therefore off the table by design.
- WHAT IS ACHIEVABLE: a per-CONDITION snapshot card. The condition id is PUBLIC (shown on home list,
  GET /v0/conditions/:id) and the countdown source `fires_at` (unix secs) is available server-side
  (db.rs:20, returned api.rs:265; NULL for at_block conditions — no absolute time). REQUIRES:
  (1) a server-visible id — new path/query like `/c/<id>` or `?c=<id>` (not just `#/condition/<id>`);
  (2) an edge/serverless renderer (none today) that reads fires_at and renders a PNG; (3) per-request
  <head> meta injection for that route. This is net-new infra, not a tweak.
- No "share to X"/intent UI exists today; only a "copy share link" button (playground.ts:653,788).

## Decision log
- 2026-07-08 (prism-plan): next-phase direction = "earn the network thesis on ONE
  painkiller." Refuted BOTH extremes: (a) traction-first on agent track records while
  deferring DKG (3/3 adversarial skeptics refuted: trusted dealer is an INTEGRITY break
  for a trust product, not a low-harm caveat; near-term demand is a mirage; the deferral
  gate is circular), and (b) solo multi-month DKG with no user (round-1 lenses). Plan =
  3 parallel tracks: (1) remove single-dealer trust hole de-risked (investigate multi-party
  SETUP CEREMONY as lighter alt to full DKG; get grant / commonware co-dev / open-source
  help), (2) validate ONE painkiller = sealed-bid/dark-block sealed order flow sold as a
  dedicated committee, with an 8-week demand kill-criterion (NOT agent records = vitamin),
  (3) cheap finishers: Sepolia run, npm publish, Railway cleanup. Token ($PEAL/$sPEAL) LAST;
  $sPEAL = highest reg risk. Full doc: docs/plans/001-peal-next-plan.md.
- Chain (grounded 2026-07-08): EIP-2537 BLS12-381 precompile is LIVE on ETH mainnet
  (Pectra) so Stage-2 on-chain verify is buildable on ETH today; Solana BLS12-381 =
  SIMD-0388, pending devnet (Agave v4.0.0-beta) + mainnet, so Solana anchor tier works now
  but on-chain verify is not yet available to programs.

## INVARIANT (2026-07-08)
- Peal's whole value is trust-minimization, so the SINGLE-TRUSTED-DEALER ceremony
  (bte-cli samples tau in one process, lib.rs:192-233) negates the value prop for EVERY
  serious use, including "low-value" reputational ones. Do not market "reveal-later
  encryption / tau is gone" or onboard any real-value or trust-selling product until the
  single-dealer hole is removed (setup ceremony or DKG). It is a launch-blocker, not a
  caveat.

## INVARIANT (2026-07-12): the deadline is NOT enforced, it is asserted
- SECOND trust hole, distinct from the single-dealer one above and NOT documented in
  spec/index.md (which only names the dealer at line 15) or #/protocol (which says "the
  cue fires: wall clock or block height" without saying WHOSE clock).
- at_time: the ONLY thing gating a reveal is `fires_at <= unix_now()` in the coordinator's
  own process (engine.rs:29-39, db.rs:85 SystemTime::now). Nothing else checks it.
- OPERATORS NEVER CHECK A CLOCK. bte-node polls /v0/work, decodes the 48-byte headers it is
  handed, calls partial(), posts the share (node/src/main.rs:150-193). It never reads
  fires_at, never fetches the condition, never looks at a clock or chain. It signs whatever
  it is given. /v0/work does not even filter on status='frozen' — only "a batch row exists
  and is not finalized" (api.rs:377-379).
- CONSEQUENCE: t-of-n buys NOTHING on timing. It only stops the coordinator decrypting with
  ZERO cooperation, and cooperation is free — a compromised/buggy coordinator inserts a batch
  row and t honest nodes cheerfully reveal a capsule whose deadline is a week out.
- at_block is WEAKER, not stronger: one unauthenticated `eth_blockNumber` POST (engine.rs:97-113)
  read by the coordinator alone. Takes the LATEST head at face value (no finalized tag, no
  confirmations, no block hash, no reorg handling, no second source). freeze is irreversible,
  so a reorg or a lying RPC = permanent early reveal. It ADDS a trusted party (the RPC) without
  removing the coordinator. NOT running a node — just reqwest posting one JSON-RPC method.
  No RPC configured for a chain id => condition stays pending FOREVER, silently (engine.rs:75-77).
- Honest guarantee ladder today: (1) no reveal without t shares — CRYPTO. (2) operators only
  share after the deadline — NOTHING. (3) revealed payloads match what was committed — merkle
  root, if anchored. (4) ciphertext existed before block N — chain, if commit() was called.
- TO CLOSE IT (both halves required, either alone is useless): (a) node evaluates the condition
  itself before partial()ing — /v0/work returns kind/fires_at/height and the node refuses until
  ITS OWN clock/RPC agrees; AND (b) the condition record must be immutable + identical for every
  operator, else a malicious coordinator just tells each node a different fires_at — so sign the
  condition at creation under a key nodes pin, or publish conditionId=>fires_at on-chain.
  THE DEADLINE IS THE ONE PROTOCOL INPUT THAT LIVES ONLY IN THE COORDINATOR'S SQLITE FILE.

## Railway persistence — SOLVED 2026-07-12 (do not regress)
- ROOT CAUSE of "every deploy wipes all conditions": /bte-state was a bare `mkdir` in the image
  (Dockerfile.railway:60) with NO volume. Railway gives each deploy a fresh container fs, so
  /bte-state came back empty every time. That empties bte.db (start-railway.sh:10) AND deletes
  ceremony/params.bin, which trips the `if [ ! -f ... ]` guard (start-railway.sh:27) and RE-RUNS
  THE TRUSTED-DEALER CEREMONY => brand-new committee id. Old conditions weren't just hidden, they
  became permanently unrevealable (their committee's operator keys no longer exist anywhere).
- FIX (applied): Railway volume mounted at `/bte-state` on the bte-explorer service. Volumes are
  DASHBOARD-ONLY (not expressible in railway.json) and are created from the PROJECT CANVAS
  (Cmd+K / right-click canvas), NOT the service Settings tab — Settings search for "volume"
  finds nothing, which is what made this hard to find.
- The mount path MUST equal STATE_DIR in docker/start-railway.sh:7 (`${BTE_STATE_DIR:-/bte-state}`).
  Change one without the other and the ceremony re-runs and orphans every seal.
- VERIFIED 2026-07-12: committee 2d7ce50d097b08665ceab77f735967bc45e0a1179803d76fec50f445b8738f9b
  (created_at 1783801633) survived a redeploy unchanged => ceremony skipped => volume holding.
  THE PERSISTENCE TEST IS: `curl -sS https://peal.adibuilds.in/v0/committees` before and after a
  deploy. Same id = good. New id = state was wiped. A fresh committee id is ALSO what a broken
  volume looks like, so one deploy alone proves nothing — you need the id to survive a SECOND one.
- Attaching the volume cost a one-time reset: committee c36dec96 + 21 conditions were lost. This
  was unavoidable (the volume starts empty, so the ceremony ran once more into it).
- WHAT WOULD STILL WIPE IT: deleting/detaching the volume; changing the mount path; deleting and
  recreating the service; setting BTE_STATE_DIR to anything but /bte-state.
- NOW-PERMANENT RISKS (previously masked by the constant wipes): the 5 operator keystores now sit
  on that volume encrypted with the DEFAULT passphrase `railway-devnet-v0` (start-railway.sh:9,
  BTE_KEYSTORE_PASS unset on the service) which is hardcoded in a public repo; and there is NO
  BACKUP — one SQLite file on one volume, lose it and every seal is unrevealable forever.
- docs/deploy-railway.md IS STALE: it describes a 7-service topology (1 coordinator + 5 nodes +
  1 web, private networking) and claims root railway.json targets Dockerfile.web. The LIVE shape
  is the all-in-one Dockerfile.railway (coordinator + in-container ceremony + 5 nodes + Caddy in
  ONE container, start-railway.sh). The doc never mentions the volume at all — the exact gap that
  cost the 21 conditions. bte-sdk / bte-examples / bte-demo-* are a library and scripts, NOT
  servers; only bte-explorer needs a domain (Caddy proxies /v0 -> localhost:8090, Caddyfile:6-14).

## Landing prompt -> capsule handoff (2026-07-12)
- The hero prompt used to DISCARD what the visitor typed (landing.ts just set location.hash),
  despite a comment claiming it "rides the hash into the app" — so they answered "what should
  stay sealed?" twice, once on the hero and again at the playground's #pg-secret.
- Now: landing.ts stashes the trimmed text via putSealDraft(); playground.ts calls takeSealDraft()
  right after renderFields(), selects the time-capsule tab, prefills #pg-secret, focuses it, and
  scrolls it into view.
- The draft rides sessionStorage (packages/explorer/src/draft.ts), NOT the URL: the text is the
  user's SECRET, and the hash would persist it in browser history and in any copied link. Cleared
  on read so a reload never resurrects it. Landing input capped at maxlength=200 to match #pg-secret.
- Reveal timing still defaults to 60s on arrival from the landing page (may be wrong for someone
  sealing a launch date — open question).

## Open items
- Remote IS live now: github.com/Adityaakr/peal-network (main deploys to Railway ->
  peal.adibuilds.in). Supersedes the old "no GitHub remote yet" note.
- Live devnet has NO chain contact: SEPOLIA_RPC_URL is unset on the service, so every condition
  actually firing today is at_time on the coordinator's wall clock. fire_at_block is dead code in
  prod until an RPC is configured.
- Sepolia run of the anchored demo pending SEPOLIA_RPC_URL +
  funded ANCHOR_PRIVATE_KEY (anvil path verified).
- Set BTE_KEYSTORE_PASS on the Railway service (currently the public default) and get a backup
  story for the /bte-state volume — both are now permanent risks, see the persistence section.
- Harden start-railway.sh: a missing params.bin is treated as "first boot, run the ceremony" when
  it actually means "the volume is gone and I am about to orphan every seal". Should fail loudly.
- Rewrite docs/deploy-railway.md to match the live all-in-one shape + the required volume.
- Public devnet: DEVNET_URL in the SDK is a placeholder
  (`https://devnet.bte.invalid`); update when a devnet exists + set the
  playground URL in docs/launch.md.
- Explorer: agent-built and gate-verified; do one human visual pass.

## Encrypted mempool: feasibility + the /encrypted-mempool playground (2026-07-12)

Measured, not guessed. `crates/bte-crypto/examples/mempool_scaling.rs` (n=5, t=3,
200-byte payloads, single thread, laptop):

| B | seal/tx | partial (per op) | pre_decrypt | combine+finalize |
|---|---|---|---|---|
| 64 | 0.41 ms | 1.1 ms | 228 ms | 35 ms |
| 256 | 0.41 ms | 3.0 ms | 1.12 s | 143 ms |
| 512 | 0.41 ms | 5.3 ms | 2.49 s | 290 ms |

- An operator does ~5 ms of work and emits a 48-byte share to open a 512-tx
  batch. That is the pitch, and it holds.
- `pre_decrypt` needs only ciphertexts + params, so it starts the moment the
  builder fixes an ordering and overlaps the publish + collect-shares round
  trip. Only `combine + finalize` is on the critical path. B=256 on a 2s L2
  fits today.
- Differentiator vs Shutter: epoch keys OVER-DECRYPT (the released key opens
  every tx encrypted to that epoch, included or not). BTE opens exactly the
  committed batch. That is the CGPP motivation and it is true at Stage 0.

BLOCKER, unresolved: setup. A mempool needs Shamir shares of tau^1..tau^n with
nobody knowing tau. That is not a standard DKG (the secret is STRUCTURED, powers
of tau) - it is an MPC over a product of contributions. Ethereum's KZG ceremony
solves the public-powers half only. Answer this BEFORE committing a mempool
roadmap: if it is intractable, "decentralized operator committee on the roadmap"
(already on the landing page) is a promise that cannot be kept.

Why the mempool is the right THESIS but the wrong NEXT COMMIT: for the
leaderboard, guaranteed reveal is the product and secrecy is a bonus, so Stage 0
ships honestly. A mempool INVERTS that - secrecy IS the product and an early read
is money, so the trusted dealer / one-container operators / unverified cue stop
being caveats and become the product being a lie. Also ~10 buyers, all courted
(Shutter, BuilderNet, Radius, Espresso), each a 6-18 month integration sale.

### The playground (SHIPPED): `#/encrypted-mempool`
The one artifact in this direction that is honest at Stage 0, because a demo has
no money, so the trust hole costs nothing. Hold this line exactly:
- SIMULATED: pool, searcher, block. `src/mempool/amm.ts`, constant-product.
- REAL: the seal (wasm, live committee params), the batch, the cue, and the
  reveal. The right-hand fill executes on plaintext read back out of
  `/v0/reveals`, NOT from a local variable. Verified: two tabs land in the SAME
  batch (2 real ciphertexts + 62 padding) and each recovers its own slot.
- The page states the trust gap in `.mp-trust` rather than hiding it.

KEY MODELLING RESULT (do not regress): a sandwich is bounded by the VICTIM'S
SLIPPAGE TOLERANCE, not the searcher's appetite. The searcher front-runs to
exactly the edge where the victim's amountOutMin would revert. So the loss lands
precisely on the slippage setting (0.5% tolerance -> 0.5% stolen), and small
swaps are not sandwiched at all because the 0.3% fee on both legs eats the edge.
An earlier unconstrained optimizer said the searcher front-runs with the whole
reserve and takes 72% of the swap - absurd, and it would have been an
embarrassing overclaim on screen. `bestSandwich()` bisects for the revert wall.

Do NOT call this an "anti-sandwich testnet". That is the Stage-2 artifact and it
requires genuinely separated operators to mean anything. This is a playground.

## Encrypted mempool ON-CHAIN: Tempo build (2026-07-12, in progress)

Decision: make the playground real on a live chain. Chain evaluated four ways
(Tempo, Hoodi, Robinhood Chain, Aptos); chose **Tempo Testnet (Moderato)**.

Chain facts (verified 2026-07-12):
- Tempo Moderato: chainId **42431**, RPC `https://rpc.moderato.tempo.xyz`,
  ws `wss://rpc.moderato.tempo.xyz`, explorer `https://explore.testnet.tempo.xyz`,
  ~0.5s BFT (Simplex) deterministic finality, Foundry supported.
- NO native gas token: gas paid in stablecoins (pathUSD default), faucet gives
  1M. `BALANCE`/`SELFBALANCE` return zero, `eth_getBalance` hardcoded -> pool
  reserves MUST be ERC-20 balances, never native. New storage slot 250k gas,
  account creation 250k, deploy 1000 gas/byte (keep per-swap SSTOREs minimal).
- No stated MEV protection + sub-second blocks = Peal fills a real, uncontested
  gap. THIS is why Tempo beat the others:
  - Robinhood Chain (46630, 100ms, Arbitrum Orbit): FCFS ordering marketed as
    MEV protection -> directly contradicts our sandwich premise. ETH faucet
    starves a high-traffic relayer. Rejected despite best specs.
  - Hoodi (560048, 12s, vanilla ETH): 12s slot kills the 2s feel; ETH faucet
    throttled. Rejected.
  - Aptos (APT): Move VM, NOT EVM. Would require rewriting every contract +
    SDK in Move (Aave-scale rewrite). Rejected for now -> see APT-later below.

Demo keys (GITIGNORED at .secrets/tempo-keys.env, testnet only):
- deployer/coordinator 0xe27d43CE3E722A30cfb0011D08A4AA78CAA03a83 (deploys,
  seeds pools, is the onlyCoordinator settler)
- relayer 0x8610be02397258E85438A6d5bd115AA89aF41eBC (sponsors visitor swaps,
  no-wallet UX)
- searcher 0xCFAD2395dAbaea0F2d895Ce5235AE8a2a8319fCB (real sandwich bot, its
  own key; MUST genuinely fail vs the sealed lane)
User funds these from the faucet.

### On-chain architecture (apples-to-apples, same adversary both lanes)
The searcher is the BLOCK BUILDER on both lanes - the worst-case adversary an
unprotected mempool faces. The ONLY difference between lanes is encryption.
- `DemoToken` ERC-20 mintable (mUSDC, mETH) - reserves are token balances (Tempo
  zeroes native).
- `SwapPool` x*y=k, 0.3% fee, `swap` gated to an immutable operator (the builder
  allowed to move it). Deployed twice: publicPool (operator=PublicBuilder),
  pealPool (operator=PealMempool).
- `PublicBuilder` models an unprotected mempool: `submitOrder` DEFERS execution
  and emits the order in CLEARTEXT (searcher sees amount+direction+minOut);
  `buildBlock([frontRun, victim, backRun])` lets the searcher execute its chosen
  ordering -> real sandwich, real extraction, real explorer links. Deferred
  execution is what makes front-running possible (must see pending-but-unexecuted).
- `PealMempool`: `commitSealed(conditionId, ctHash)` emits only the HASH (searcher
  has nothing to wrap); `executeBatch(conditionId, orders, merkleRoot)` is
  onlyCoordinator, recomputes the merkle root over (position_le_u32 || payload)
  leaves via the sha256 precompile to bind execution to the revealed batch, then
  swaps in committed order. Sealed order payload = deterministic encoding the
  contract can decode (NOT JSON) so leaf recomputation matches the reveal.
- Merkle model mirrors coordinator merkle.rs + sdk anchor.ts: leaf =
  sha256(pos_le_u32 || payload), parent = sha256(l||r), odd promoted. conditionId
  on-chain = sha256(utf8(id)). ctHash = sha256(sealed ciphertext) (unchanged).
- Settlement runs as a TS service (settler) watching the coordinator reveal API,
  NOT inside the Rust coordinator - keeps the shipped devnet untouched (low
  regression risk) and all chain/viem logic in TS.

Speed: none of the latency is crypto. pre_decrypt already pipelined at freeze
(engine.rs:194); engine ticks 500ms; combine+finalize ~35ms @ B=64. The 30s wait
was round length + poll intervals. Target ~2s seal->settle: short cue, add a
coordinator->client reveal push (SSE), tighten demo committee poll.

Honest gap unchanged: dealer-trusted committee, operators don't verify the cue,
coordinator provides the ordered plaintexts to executeBatch. State on the page.
Contracts + settlement are real on Tempo; decentralisation is not yet.

### Build status (2026-07-12) — VALIDATED end-to-end on anvil + live coordinator
DONE and committed (branch encrypted-mempool-playground):
- contracts/ : DemoToken, SwapPool, PublicBuilder, PealMempool + DeployMempool
  script. 23 Foundry tests green; Solidity merkle cross-checked vs python oracle.
- packages/mempool-agents/ : relayer (sponsored no-wallet gateway + read API),
  searcher (real sandwich bot, its own key), settler (watches coordinator
  reveals -> executeBatch). Shared bigint sandwich sizing mirrors the model.
- packages/explorer #/encrypted-mempool : rebuilt to drive the real chain
  (seal -> commit -> public order -> poll both to settlement), block-explorer
  links, honest trust-gap note. Old float amm.ts deleted.

Proven in a real browser (Playwright): $50k swap -> public victim pushed to
15.7394 ETH (its exact 0.5% floor), $212.99 lost to the sandwich on-chain
(victim's execution shortfall vs the fair quote, NOT the searcher's net profit —
the attacker also pays LP fees and gas); SAME swap sealed -> settled by
PealMempool.executeBatch at the cue (30.5s) for 15.8186 ETH (full quote), $0
lost. Real tx refs on both lanes, no page errors.

Local stack wiring that worked: anvil :8546 (chain 31337), deploy addresses in
packages/mempool-agents/deployments/31337.json, relayer :8799, searcher, settler
with COORDINATOR_URL=live devnet (bte-explorer-production). Explorer dev server
:5199 with BTE_URL=live devnet; VITE_RELAYER_URL defaults to :8799. Gotchas
fixed: approve the POOL not the builder; serialize per-key sends (nonce races);
/state must be wei; settler must snapshot pre-existing reveals (stale JSON-payload
mempool conditions from the old simulation revert executeBatch).

LIVE ON TEMPO (2026-07-12). Deployed to Moderato (chain 42431), verified in a
browser with clickable explorer links. Live addresses in deployments/42431.json:
usdc 0x57a72cff.., eth 0x97c4bfa8.., publicPool 0x29afed03..,
publicBuilder 0x1a3dcf7f.., pealPool 0x652128057.., pealMempool 0x490dcec0..
Coordinator/settler = deployer 0xe27d43CE. Explorer: https://explore.testnet.tempo.xyz.
pathUSD (gas token) = 0x20c0..0000; the 3 keys hold ~2M pathUSD each.

Tempo deploy gotchas (SOLVED): eth_estimateGas under-provisions (Tempo charges
~1000 gas/byte deploy + 250k/new slot); deploy needs
`--gas-estimate-multiplier 2000`, agents pass TX_GAS=30000000 via writeGas.
Settler double-submit race fixed (mark done before first await).

Run live: agents with CHAIN_ID=42431 TX_GAS=30000000 + .secrets keys, settler
COORDINATOR_URL=live devnet; explorer VITE_RELAYER_URL defaults to :8799, seals
into the live devnet coordinator (same one the settler watches).

STILL LOCAL-ONLY (not blocking): the relayer/searcher/settler run on this
machine, not hosted. To make the public URL fully live, host the 3 agents
(e.g. Railway) and set the explorer's VITE_RELAYER_URL to the hosted relayer.

## Encrypted-mempool page REDESIGN (2026-07-12, DONE)
Shipped and verified in-browser (desktop + mobile). All requests met: title just
"encrypted mempool", DEX-style swap card (pay/receive tokens, live quote, rate,
slippage, min received, one Swap button, no wallet), a smooth blur/fade
transition from swap -> comparison, two equal-height aligned lanes, CSS-3D
scenes (sandwich clamps the blue victim between red attacker slabs with a flat
front-run/your-swap/back-run legend + coins flying to searcher; sealed vault the
searcher orbits then opens to a green ETH core at the cue), a big "$X kept on
Peal" difference banner, and the trust text moved to a collapsible FAQ. Fixed a
[hidden]-vs-display:flex gap bug. Added a KEEPER agent (packages/mempool-agents/
src/keeper.ts, deployer key) that holds both pools at $3000/ETH so repeated demo
swaps stay legible ($250k keeps getting sandwiched). Default swap $250k.
Files: pages/mempool.ts, mempool/visuals.ts, mempool/chain.ts, style.css.

### Logos + pair flip (2026-07-12, DONE)
Real USDC (Circle mark) and ETH (diamond) inline-SVG logos replace the colour
circles. The swap arrow is a flip button reversing the pair (USDC<->ETH); the
whole flow is direction-aware (quote, seal baseToQuote, public order, result
units, profit valuation, kept-USD). Contracts + searcher were already
direction-agnostic. Verified both ways on Tempo.

### Swap UI + live BTE proofs + verifiable contracts (2026-07-12, DONE)
- Swap card DEX-styled in Peal light theme (ref: a Squid/Jumper dark widget):
  real USDC/ETH logos in token pills + chevron (click to flip), USD value under
  each amount, "on Tempo" sublabel, Tempo network badge, logo inline in result.
- "How Peal sealed and proved your swap": 3 aligned cards populated with REAL
  artifacts as the swap runs (client.committee()/status()/reveal()): (1) sealed
  = ciphertext hash + payload bytes + "searcher sees nothing"; (2) batched =
  t-of-n operator pips + this batch's real+decoy count + params digest; (3)
  revealed = verified share checks + merkle root + on-chain executeBatch that
  re-derived it. This is the "convince someone technically" section the user
  asked for. proofStep/proofRow/operatorPips/checks builders in mempool.ts.
- FAQ: "How can I verify it myself?" lists all 6 contracts linked to the Tempo
  explorer (addrUrl); "How does the sealing actually work?" explainer. /config
  now serves usdc/eth addresses; MempoolConfig gained usdc/eth + addrUrl().

### Peal deep-dive as 3D process cards (2026-07-12, DONE)
User: the flat 3-text-card "how Peal works" was "too bad"; wanted 2 sections
LIKE the comparison lanes, with 3D visuals, more verifiable, clear links.
Rebuilt as "inside the peal mempool": two cards uniform with the outcome lanes,
each with a real CSS-3D scene (visuals.ts createBatchScene = your locked order
among 63 faint decoys in a tilted 8x8 grid; createRevealScene = 5-operator ring
animating sealed->proven, t lit green firing shares into a green check core) +
the live artifacts. Card 2 has a prominent "verify the full batch — every slot,
share & timing" link to #/condition/:id (the existing rich condition-detail page
the user liked: slot grid, per-operator pairing checks, merkle root, batch json
download). Flow now reads as one uniform system: outcome -> difference -> how
Peal did it -> verify.

### Peal deep-dive v2: 4-step animated pipeline (2026-07-12, DONE)
User: the 2 process cards were "still fucked up / not professional"; wanted 4
structured sections, real 3D ANIMATIONS showing what happens, trust copy, and NO
em-dashes (brand rule I had violated). Rebuilt as "how Peal keeps your order
private": a vertical pipeline with a numbered timeline rail and 4 cards, each
with a continuously LOOPING CSS-3D animation + trust-first copy + real artifacts:
1 encrypted on your device (card flips plaintext->ciphertext), 2 hidden inside a
batch (order drops into 64-slot grid of decoys), 3 sealed to a distributed
committee (shards fly core->5 operators), 4 revealed & proven on-chain (quorum
shares fly back, core opens green + on-chain badge). Step 4 links to
#/condition/:id. Scenes: visuals.ts createFxEncrypt/Batch/Commit/Reveal (loop via
CSS, no JS state). ALL em-dashes removed from mempool.ts; placeholders use "·".
FLOW_COPY holds the 4 trust paragraphs. Animations decoupled from swap state so
they always show motion; real data fills each step's data rows as it lands.

### Symmetric attack pipeline (2026-07-12, DONE)
Public side was one card vs peal's 4-step pipeline (lopsided). Added "how the
public mempool takes your money": a red-themed 3-step pipeline structurally
identical to the peal one, with looping CSS-3D scenes (visuals.ts createFxExposed
= readable order + scan beam + watching eye; createFxFrontrun = searcher token
jumps ahead of "you" + price up; createFxSandwich = attacker slabs clamp victim,
coins fly to searcher) + real data (your order/floor, front-run, victimOut vs
quote, $ taken, on-chain tx). flowStep now takes a `pub` bool -> red chip + red
done-state + p-prefixed ids (mp-pstep/pviz/pdata). PUB_COPY holds the 3 attack
paragraphs. Page reads problem (attack) then solution (protection), both lanes in
matching depth. Full order: swap -> outcome comparison + diff -> public attack
pipeline -> peal protection pipeline -> FAQ.

### Fair-comparison fix + committee symbols (2026-07-12, DONE)
SERIOUS bug the user hit: public and peal are SEPARATE on-chain pools that drift
independently, so with no sandwich peal could show LESS than public (esp. one
direction) and the sandwich amount was unclear. Fix: SwapPool.adminSetReserves
(admin = relayer, pulls deficit / returns surplus) + relayer POST /prepare resets
BOTH pools to an identical 30M/10000 ($3000) before every swap (browser calls it
first in run()). So the only difference is the sandwich; peal >= public always.
Redeployed (admin param + big relayer reseed buffer). Diff clamped >= 0.
Verified both directions: USDC->ETH $1236 kept, ETH->USDC $1187 kept, peal>=public.
Keeper NOT run anymore (would reset mid-swap); /prepare owns pool state per swap.
New deploy addresses in deployments/42431.json.
Visual: committee operator dots -> rounded nodes with a blue key-share glyph +
shadow, green + check when they return a share; flow cards got a base shadow.

### Pool depth tuning for small swaps (2026-07-13)
User: small swaps ($5-10k) showed "too small to sandwich". Sandwich threshold ~
0.003 * input-side-reserve, so a deep pool only sandwiches whale trades. Since
/prepare resets both pools to a target every swap, pool depth is a free dial (no
drift cost). Set relayer TARGET_BASE/QUOTE to a $1.8M pool (900k USDC / 300 ETH,
$3000/ETH) -> threshold ~$5k. Default swap lowered to $10k USDC / 3 ETH.
Verified: $5k ($25 taken), $10k ($50), 8 ETH ($117) all sandwich, peal>=public.
To change the threshold later, just change TARGET_BASE/QUOTE in relayer.ts and
restart (no redeploy). NB test /public-swap with a real minOut (fair*(1-slip)),
not minOut=1, or the searcher front-runs the whole pool.

### Encrypted-mempool landing page (2026-07-13)
User supplied a Peal design-system zip with a `mempool-landing` UI kit (React +
Babel). Ported it to a clean vanilla-TS explorer route at #/mempool (pages/
mempool-landing.ts) instead of pulling in React: split-mempool hero with a
10-beat sandwich->bloom loop (phase classes is-scan/is-attack/is-dissolved/
is-finalize/is-bloom driven by setInterval), footnoted problem stats, 6-step
pipeline, batched-vs-per-tx-vs-per-epoch table + O(n) diagram + pull-quote,
capsule anatomy + committee ring, integration snippet, honest-limits, roadmap
(chain-level = "in build"), CTA. Hero "try the playground" -> #/encrypted-mempool
(the live demo). Design tokens already matched explorer CSS; added the missing
warm/code/accent-strong vars. Nav "encrypted mempool" now -> #/mempool. All
landing styles are .ml-* in style.css; sections use the existing scroll-reveal.

### In-browser reveal verification (2026-07-13)
Condition dashboard (#/condition/:id, pages/condition.ts) now has a "recompute
it here" button: packages/explorer/src/merkle.ts rebuilds the merkle root in the
browser from all 64 revealed plaintexts (leaf=sha256(pos_le_u32||payload),
parent=sha256(l||r), odd promoted; mirrors coordinator merkle.rs) and compares
to the published root, showing verified/mismatch. Validated: browser recompute
== live coordinator root for cond_cea56d21 (9dcb6315..7918). The sealed ct hash
(sha256(ciphertext)) is the pre-reveal on-chain commitment and is NOT
recomputable from a plaintext, so the client check is on the merkle root.

### Docs
Long-form explainer at docs/encrypted-mempool-explained.html (self-contained
HTML, Mermaid architecture diagram, brand tokens). Covers the problem, the
architecture, the 8-step BTE flow, why batched (48-byte O(n) shares), the
in-browser verification, live data (chain 42431, current 42431.json addresses,
committee 5/3/B=64, ~90ms reveal, 5s cue, CoinGecko pricing, $100k cap), and the
honest v0 limits. Written by /prism-write, grounded in real files.

### Live-price pooling + swap cap (2026-07-13)
relayer /prepare sets the ETH reserve from live CoinGecko ETH/USD (60s cache,
fallback 2500), USDC depth constant (900k) so sandwich behaviour is price-stable;
pools primed on boot. Explorer derives price from reserves so rate/USD/cap track
real prices with no explorer change. mempool.ts caps a swap at $100k of value
(USDC 1:1, ETH via price): over-cap disables the button ("max $100,000 per swap").
Cue shortened to 5s.

### Tempo-under-load learnings (robustness)
Rapid concurrent test swaps wedged agent nonces (a stalled tx blocks everything
behind it; symptom: relayer /commit hangs forever). Fixes applied: TX_GAS
lowered 30M->8M (real calls need <1M; 30M was oversized), relayer waits receipts
with a 60s timeout (waitReceipt) so a stall errors instead of hanging. To clear a
wedge manually: `cast send <addr> --value 0 --nonce <stuck> --gas-price <high>
--private-key ...` until latest==pending. The keeper can overshoot if a swap
lands mid-reseed, but self-corrects next cycle. Normal single-user pacing
(~1 swap/30s) does not trigger any of this.

--- original notes ---
## (superseded) Encrypted-mempool page REDESIGN (2026-07-12, in progress)
User wants a clean, engaging visual (current page too text-heavy). Direction:
- Title just "encrypted mempool" (drop the long hero paragraph).
- A real DEX-style swap card first: show pay/receive tokens, live quote, price
  "1 ETH = X USDC", slippage, min received, a Swap button (looks like Uniswap).
- On Swap: the swap card smoothly animates away, then the public-vs-peal
  comparison animates in.
- Comparison: two panels EQUAL height/aligned (current ones drift in size), each
  with a 3D visual showing clear value transfer + the difference. 3D "sandwich"
  motif for the public lane; sealed vault/cube for peal. CSS 3D only (no libs,
  CSP), same approach as ceremony.ts.
- Move the "what is real here" trust text into an FAQ section at the bottom.
Pools redeployed DEEP (30M USDC / 10k ETH = $3000/ETH) so repeated demo swaps
barely drift the price; addresses in deployments/42431.json (updated).

## Vara.eth (eth.vara.network) — EVALUATED 2026-08-03, verdict NO for now

Asked: should Peal add Vara.eth as a chain? Answer: it is not a chain you can add,
and the one angle that would be strategically interesting is blocked by a measured
hard gas ceiling plus a trust model that contradicts the product.

### What Vara.eth actually is (grounded, wiki.vara.network/docs/vara-eth + gear-tech/gear source)
- NOT a rollup, NOT a chain, NOT EVM. Off-chain WASM execution network ("ethexe")
  whose state commits to Ethereum L1 via a Router contract, one `Mirror` contract
  per program. Its own docs: "It's an application layer, not a new chain."
- Chain id MAINNET = **1** (literally Ethereum mainnet, Router
  `0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6`, live since block 24,734,869 /
  2026-03-25). TESTNET = **560048** (Hoodi). Explorer is etherscan.
- Programs are Rust -> WASM (`sails-rs` with `features=["ethexe"]`), target
  `wasm32v1-none`, `no_std` mandatory, uploaded as an EIP-4844 blob. **Solidity
  cannot be deployed to it.** Foundry/forge/hardhat appear nowhere in its docs.
- Solidity can only CALL INTO it: `mirror.sendMessage(payload)` returns a message
  id, never program output. Every Solidity<->Vara.eth call is a 2-tx async round
  trip needing an off-chain keeper.
- Reverse gas: user pays ETH for the L1 tx (~60-100k gas); the PROGRAM pays compute
  from an `executableBalance` denominated in **wVARA** (decimals = **12** on-chain;
  two wiki pages wrongly say 18). Prefund via `approve` + `executableBalanceTopUp`.
- Forbidden syscalls on ethexe: `CreateProgram` (a program cannot spawn programs),
  `Random` (no on-chain randomness), indefinite `Wait`, all gas-reservation and
  `*WGas` variants. `wait_for`/`wake`/delayed sends ARE allowed.
- Undocumented hard caps (source only, `ethexe/runtime/common/src/lib.rs`):
  MAX_OUTGOING_MESSAGES_PER_EXECUTION = 4, PER_RUN = 16, 4 KiB payload budget per
  run. That kills any fan-out settlement design (e.g. 64-slot batch execution).

### Why NOT the encrypted-mempool demo
- Porting = rewriting all 5 Solidity contracts in Rust. ~250 of 491 `src/` lines
  port mechanically (all of `BteAnchor.sol`, the merkle half of `PealMempool`,
  `DemoToken` -> VFT, `getAmountOut`). The other ~240 do NOT, and they are the
  demo: `PublicBuilder.sandwich` (`PublicBuilder.sol:73-93`) needs three
  synchronous `pool.swap` calls with a data dependency and all-or-nothing
  atomicity (`:67-71`). In an actor model each becomes an awaited message, there
  is no cross-message rollback, and other traffic interleaves at every await.
  `test_public_sandwich_reverts_when_it_breaches_victim_floor`
  (`contracts/test/EncryptedMempool.t.sol:130-144`) becomes unimplementable.
  **An actor-model port WEAKENS the demo's own thesis**: the sandwich stops being
  deterministic, which is a worse story than "the order was readable."
- `PealMempool.executeBatch`'s swap loop (`PealMempool.sol:76-83`) becomes N
  awaited round trips, and `settledRoot` is written at `:73` BEFORE any swap, so a
  mid-loop failure = permanently-partial settlement with no re-entry (`:69`).
- The fix is to merge PealMempool+SwapPool into one program per lane, dissolving
  the 4-contract topology the demo's apples-to-apples framing depends on.
- `abi.decode` of the order payload (`PealMempool.sol:78-79`) would become SCALE
  or Borsh, which changes the leaf preimage and therefore every merkle root.
  Coordinator `merkle.rs` + SDK `anchor.ts` would have to switch codecs in lockstep.
- Hoodi (560048) was ALREADY evaluated and rejected in the 2026-07-12 chain rubric
  above ("12s slot kills the 2s feel"). Vara.eth testnet settles to exactly Hoodi.
  Vara.eth mainnet is Ethereum mainnet = real money, violates testnet-first.

### The one interesting angle, and why it is blocked (MEASURED, not estimated)
ROADMAP item 5 (`spec/ROADMAP.md:19-23`) wants an on-chain verifier and gates it on
EIP-2537 because Solidity cannot do pairings. A Rust ethexe program needs no
precompile at all: it links arkworks directly, and `crates/bte-wasm` already
compiles the full verify path to wasm32 (`bte-wasm/Cargo.toml:11-13`,
`src/lib.rs:60-70`). So "no BLS builtin on ethexe" is NOT the blocker. The blocker
is gas, and it was measured directly (arkworks built for `wasm32v1-none`, run
through `gear-wasm-instrument` 2.0.0 + `gear-core` 2.0.0, executed under wasmtime,
`gear_gas` global read):

| workload | native | measured gear gas | vs 1e12 ceiling |
|---|---|---|---|
| 6 pairings | 1.66 ms | 4.84e11 | 0.48x |
| 15 pairings | 3.19 ms | 9.92e11 | 0.99x (the cliff) |
| **65 pairings (our B=64)** | **11.67 ms** | **3.83e12** | **3.83x FAIL** |

- Fitted `gas(B) = 1.93e11 + 5.68e10 * B` -> **max batch that fits one message is
  B ~= 14**. Our `verify_share` (`bte-crypto/src/lib.rs:320-322`) is a multi_pairing
  over B=64 terms, not ~5 as one might assume from the API shape.
- The ceiling is HARD: `process_dispatch` does
  `gas_multiplier.value_to_gas(executable_balance).min(CHUNK_PROCESSING_GAS_LIMIT)`.
  **Funding the program with more wVARA does not raise it.**
- Gas-to-wallclock is documented as **1 gas = 1 picosecond**
  (`vara/node/authorship/README.md:76`), so 1e12 gas = 1.0s of reference compute.
  But gear OVERCHARGES this workload ~328x vs native (real wasmtime slowdown is
  only ~10x; the gap is gear's conservative instruction schedule + metering
  self-charge). Defensible number to quote: **~3 ms of our native compute per
  Vara.eth message.**
- `pre_decrypt` (245 ms) = 80x over the message ceiling and 8.9x over the whole
  BLOCK gas limit. `combine`+`finalize` (37 ms) = 12x over. Both stay off-chain
  permanently regardless.
- Vara Network's own wiki says why its Substrate BLS builtin exists: "the Wasm VM
  used in Vara is not capable ... of processing them quickly enough to fit within
  the single block time", "would occupy 30+ blocks". ethexe has **zero** builtin
  actors (`grep -ril builtin ethexe/` = 0 matches across 334 files).
- THE UNBLOCK TO TRACK: gear-tech/gear **PR #5582** (`gr_crypto` syscall with
  `Bls12381Verify`, native arkworks behind a syscall) against issue #5456. Would
  collapse the 328x overcharge to ~1x and make B=64 trivial. Unmerged, weights
  are placeholders. Until it lands, on-chain verify is B<=12 only, and B=64 is
  baked into our ceremony CRS (see "Dummy padding" above), so B=12 needs a new ceremony.

### The disqualifier for a trust-minimization product (verified on-chain)
- `validatorsCount()` = **4**, `validatorsThreshold()` = **3**, all four EOAs on
  `*-eth.vara.network` domains, **all Gear-operated**.
- `Router.owner()` = `POAMiddleware.owner()` = `0x19fdA330957933cdF61c09D8793a29F64D43d945`,
  `eth_getCode` -> `0x`. A plain EOA, not a Safe, not a timelock. It controls
  `setValidators()` and UUPS `_authorizeUpgrade` on both contracts.
- It is **not FROST** despite the whitepaper: all 21 mainnet `commitBatch` txs are
  `signatureType = 1` (ECDSA), hardcoded at `ethexe/ethereum/src/router/mod.rs:480`.
  No FROST implementation exists in the Rust node.
- Symbiotic restaking entry points revert `"not implemented"`. No economic
  security. PoS is roadmapped Q4 2026. No audit.
- Honest summary: **1-of-1 key over a 3-of-4 quorum run by one company, unaudited.**
  Enforcing Peal's cue there swaps "trust the coordinator's sqlite" for "trust one
  Gear key." That does not compose into a trust-minimization story, and per the
  INVARIANT (2026-07-08) above it would be a launch-blocker-class claim.

### What IS free today (do this instead of an integration)
Vara.eth settles to Ethereum, and the coordinator already has a per-chain RPC
registry (`crates/bte-coordinator/src/state.rs:19-20,31-37`). Setting
`BTE_RPC_URL_1` (or `BTE_RPC_URL_560048` for Hoodi) gives at_block cues on the
chain Vara.eth commits to, with **zero code change**. Note prod currently has NO
chain contact at all (SEPOLIA_RPC_URL unset), so this would light up the at_block
path in production for the first time.

### What would flip the verdict
`docs/plans/001-peal-next-plan.md:19-23,60-62,118-120` says the one thing that
changes the calculus is money: Track 1 wants "a grant, or co-development" to pay
for removing the trusted dealer, and the doc says outright that deferring the hard
crypto is rational "if the goal is a fast ... demo for a grant. Name the goal."
So: a funded Vara ecosystem engagement flips this from distraction to rational.
Unfunded, it competes badly against the cheap high-credibility queue already
listed above (isReal-not-in-leaf ~3 lines + redeploy; serve share bytes; re-derive
ct_hash client-side; the phantom BteAnchor).

### If it is ever built, the shape is an ANCHOR/VERIFIER program, not the demo
Smallest honest target: a Vara.eth program holding `conditionId -> merkle root`
plus (at B<=12, or post-#5582 at B=64) on-chain share verification and cue
enforcement. That is the shape of the deferred Solana "anchor tier"
(`001-peal-next-plan.md:99-101`), NOT a port of the 5-contract swap demo.
Structural point in its favour that a contracts-first view misses: a Sails crate
fits the existing cargo workspace (`Cargo.toml:3-9`) and Rust-only CI
(`.github/workflows/ci.yml`) far more naturally than Solidity ever did.
HARD CONSTRAINT: the verification UI needs a browser-reachable RPC with
`access-control-allow-origin: *` (`packages/sdk/src/anchor.ts:119-138`), else
"verify it yourself" degrades back into the self-consistency trap.
Practical gotcha found while measuring: `dlmalloc` emits `memory.grow`, which
gear's gas injector rejects; real gear programs page in via the `gr_alloc` syscall.
Code size is fine (170-282 KB instrumented vs a 512 KiB limit).

## APT / Move support (LATER, not now)
Aptos is Move-VM, not EVM - our Solidity contracts + EVM SDK path do not run on
it. A real APT target = a from-scratch Move rewrite of DemoToken/SwapPool/
PublicBuilder/PealMempool + a Move-side anchor/settlement, with the wasm seal
(chain-agnostic) reused. Treat as a separate product bet on the Move ecosystem,
scoped only after the EVM/Tempo demo lands. Do NOT bridge; native Move or nothing.

## Telemetry (final run)
- divergence: n/a (execution build; spec was the approved plan)
- models: main loop + 1 explorer subagent; gates (executable) replaced skeptic panels
- claims: all DoD rows verified in-session except "CI green" (supported: same commands local)
- fleet: 1 subagent · overhead vs single-pass ≈ 1.1x

## Share-link shortening (decided 2026-08-22 by prism-plan, doc: docs/plans/002-short-share-link.md)
- Link is 142 chars today: origin 21 + `#/s/` 4 + `cond_`+24hex 29 + 64-hex ct_hash 65 + 22-char
  key 23. Only the 22-char key carries secret bits; the other 93 chars are identifiers.
- DECISION: 8-byte server-issued random code minted INSIDE submit_ciphertext, returned with
  ct_hash, resolved via new `GET /v0/seals/{code}`. Link -> 59 chars private / 36 public.
  Key stays in the fragment. Rejected: ct_hash prefix, self-contained packed blob, HKDF seed.
- MEASURED (criterion, n=5 t=3 B=64, Apple Silicon): honest seal = 420us = 2,467/s. Junk-hash
  grind = 3,263,981 candidates/s (1 sha256 each).
- **`submit_ciphertext` validates almost nothing** — `SealedCiphertext::from_bytes`
  (`wire.rs:395-405`) checks magic, type byte, G1 subgroup on ct0, length bounds only. `ct1`
  (128 bits) and `ct2` (<=4096 bytes) are UNCHECKED. FO well-formedness (`ct0==[H_R(K,msg)]_1`)
  runs only at reveal (`lib.rs:410`). So ct_hash is grindable at sha256/ASIC speed, though the
  cheap tier yields `valid=false` rows that `seal-view.ts:167` refuses to render.
- **`seal-view.ts` NEVER imports `verify.ts`** — sole importer is `pages/condition.ts:14`. The
  recipient page does zero independent verification (no chain read, no re-hash, no merkle). Any
  claim that the seal page "verifies" anything is false as of this date.
- **Pre-reveal ct_hashes are NOT publicly enumerable.** `list_conditions` + `get_condition` return
  counts only; `get_reveal` 404s for the whole pending window (`api.rs:541-575`). Corrects the
  assumption that the seal index is already public.
- `sdk/src/index.ts:190` `seal()` already returns an OBJECT `{ctHash, sealedB64}`, so adding a
  `code` field is additive and non-breaking.
- Redirect-based shorteners are STRUCTURALLY DEAD here: RFC 9110 sec 10.2.2 inherits the request
  fragment only when `Location` has none, and a hash router's target always has one. Caddy's
  `try_files` (`docker/Caddyfile:12`) is an internal rewrite (200, no 3xx), so real path routes
  need no Caddy change if ever wanted.
- Shortening buys NOTHING on X (t.co = fixed 23-char weight). The real driver is email/quoted-text
  wrapping at 76-78 cols, which breaks the link inside the key segment; `seal-view.ts:189-190`
  already ships the error string for it.

## Live bugs found 2026-08-22 (not yet fixed)
- **P1 key leak to Google.** `seal-view.ts:81` `const url = location.href` (fragment + AES key)
  -> `gcalUrl` (`attention.ts:83-91`) puts it in the `details=` query param of a
  calendar.google.com URL rendered as a live anchor at `seal-view.ts:87`. One click sends the
  decryption key to Google. `icsHref` (`attention.ts:56-79`) writes it into `URL:`/`DESCRIPTION:`
  of the .ics. Nothing strips the fragment. Contradicts `privacy.ts:1-4`, `protocol.ts:376-377`,
  `docs/protocol.html:588-589`, `docs/how-peal-is-built.html:379`.
- **P2 rate limiter decorative + OOM.** `api.rs:96-106` trusts the FIRST hop of `X-Forwarded-For`
  with no trusted-proxy check; Caddy appends the real IP, so an attacker-supplied value wins.
  `state.rs:68` buckets map is keyed by that string and is NEVER pruned (grep: no
  retain/remove/clear). `cors` is outermost and short-circuits OPTIONS before `rate_limit`.
- **P3 batch pollution.** Structurally-garbage ciphertexts pass submit and occupy real slots
  through freeze, surfacing as `valid=false` (see the validation gap above).

## Decision log
- 2026-08-30 — **Post-quantum Bitcoin ownership commitments: assessed, not built.**
  Full write-up `docs/plans/004-post-quantum-ownership-commitments.md`.
  Three facts worth not re-deriving: (1) BIP-361's "Phase C" ZK-proof-of-BIP-39-seed
  recovery was DELETED by commit `ab2ebe2` three days after merge — press and
  bip361.org still describe the superseded draft; the live asymmetry is BIP-32
  hardened derivation. (2) Paradigm published PACTs 2026-05-01 with the exact
  commitment+OTS+STARK construction, and Delving Bitcoin had it in Feb 2026 —
  no novelty left in the mechanism. (3) **BLS12-381 is Shor-broken (same DLP
  family as ECDSA), so `simple-bte` (Cargo.toml:19) is NOT reusable for any
  post-quantum product and must never be positioned as PQ expertise.**
  Open ground found: competing/duplicate claims on one UTXO is unanalysed in the
  literature, and `docs/auctionkit/decisions/0004-void-and-dispute.md` already
  contains the answer pattern.

## Peal Live (built 2026-09-03, branch feat/peal-live)

A sealed auction a livestream audience enters with no wallet, no sign in, no
gas and no extension. `#/live` creates one, `#/live/<terms>` is the auction.
Pure logic in `packages/live` (peal-live, 116 tests), pages in
`packages/explorer/src/pages/live-create.ts` + `live.ts`, chain in
`packages/explorer/src/live-anchor.ts`. Architecture: docs/plans/005-peal-live.md.

### MEASURED, do not re-derive
- **The FO ciphertext length tracks the payload, so an unpadded bid leaks its
  magnitude.** Against the live coordinator: `"5"` sealed to 100 base64 chars,
  `"250"` to 104, `"1000000000"` to 112. `ct2` is a `Vec<u8>`
  (bte-crypto/src/lib.rs:125) and the FO body is a keystream XOR, so the blob
  is `69 + payload`. Fixed-width 96-byte records put all of them at 228.
  ANY future payload sealed from a form must be fixed width for the same reason.
- **`ct_hash` is just `sha256(sealed wire bytes)`, so the browser can derive it
  with WebCrypto and no wasm.** Verified 3/3 against the coordinator's echoed
  value. This closes the "ct_hash is coordinator-asserted" hole recorded above
  for the Live path; `peal-live/src/ciphertext.ts:ctHashOf`. The rest of the
  product still takes `resp.ct_hash` on trust (sdk/src/index.ts:206).
- `tempo_fundAddress` works from a bare curl with no key at all (returns 4 tx
  hashes). Confirmed 2026-09-03, chain 42431.
- `engine.rs:116` freeze pads to a MULTIPLE of B and opens `total/b` batches, so
  more than 64 bidders already works with no change.

### Design decisions that are load bearing
- **The bidder touches no chain and holds no key.** An earlier design anchored
  every bid from a per-bidder ephemeral key. Rejected on four counts: `Sealed`
  indexes `from` (PealMempool.sol:42) so one eth_getLogs enumerates every
  auction a browser bid in; `commitSealed` is permissionless and writes no
  storage, so junk hashes under a real condition id turn set-reconciliation
  checks (verify.ts:158-163) red for free; a key per bid drains the faucet; and
  it anchors `resp.ct_hash`, which is the coordinator's word anyway.
- **One host-side transaction anchors `sha256(terms)`.** The lookup is an EXACT
  match on `(conditionId, termsHash)`, never a set reconciliation, which is
  precisely why junk commitments cannot produce a false answer either way.
  Anchored live in block 33615250 on Moderato.
- **The auction id is sealed INSIDE the bid record**, because a ciphertext is
  not bound to a condition (SECURITY.md:38-42) and can be replayed into another.
  `buildBoard` discards a bid naming a different auction.
- **Padding is detected by the `BTE_DUMMY_V0:` marker, never by the API's
  `is_dummy` flag.** A test seals a real bid with `is_dummy: true` beside it and
  expects it to count.
- **The spoken checksum is the only defence against a swapped link.** A forger
  can create their own condition and anchor their own terms, and the result is
  internally consistent. A livestream supplies the out-of-band channel that
  makes the comparison possible; an emailed link would not.

### Bugs found by attacking it, now pinned by tests
- `parseAmount` stripped every comma, so `"12,50"` became 125000, a **100x
  overbid**, sealed and unrecallable. Commas are now accepted only in valid
  thousands positions.
- `canonicalTerms` hashed the TRIMMED title while `unpackTerms` returned the
  untrimmed one, so padding a title with newlines produced a different link with
  an **identical checksum and identical terms hash**. `unpackTerms` now returns
  canonical values and refuses any link that does not re-pack to itself.
- A bid clicked in the up-to-2s window after the close was **silently dropped**:
  the error wrote into a panel the poll had already replaced. Errors now survive
  a repaint (`noticeHtml`) and the close is checked before sealing.
- A link naming a nonexistent condition polled 404s forever (31 in 60s per tab)
  and showed a working bid form. Now stops after 3 misses.
- Lone surrogates collapse to U+FFFD in TextEncoder, so a bid was discarded as a
  replay of itself. `encodeBid` refuses text that is not well formed.
- `rememberMyBid` ran after the mounted check, so navigating mid-seal landed the
  bid and lost the receipt, letting the same person bid twice.

### Known and disclosed, NOT fixed
- The host can shill bid from a second browser and it is undetectable. The page
  claims sealing and ordering, never distinctness of bidders.
- One browser can bid twice by clearing localStorage. The one-bid affordance is
  cosmetic and the copy does not claim otherwise.
- No escrow. A verifiable winner, not a collected payment.
- The close is the coordinator's clock; the dealer is still single-trusted. Both
  are stated on the page in those words.

### One creation page, one chain (2026-09-03)
- `#/create` is now the ONLY creation surface. It opens with a kind picker:
  `live` (Peal Live, nothing escrowed, no sign in for anyone) and `sale` (the
  existing escrowed on-chain auction, which still needs a signed-in issuer).
  `pages/live-create.ts` was deleted; `#/live` is kept as an alias that lands on
  the same page with `live` chosen, and `#/live/<terms>` is still the auction.
- The `sale` branch still requires sign in ON PURPOSE. The factory pulls the
  whole supply out of the issuer's wallet and the proceeds land back there, so
  an ephemeral browser key as issuer would put real balances behind a key with
  no recovery path. Making that one-click needs a custody decision first.
- **Hoodi is gone.** `HOODI`, `HOODI_DEMO`, `hoodiChain`, `HOODI_PERMIT_TOKENS`
  and `CHAINS` are removed from auctionkit; `DEPLOYMENTS` and `CHAIN_FOR` hold
  Tempo only; Privy `supportedChains` is Tempo only; the Hoodi entry is out of
  `fund-plugin.ts`. None of the removed exports had a call site. `SUPERSEDED`
  still explains retired addresses, and a test now asserts that.
- Remaining "hoodi" hits are historical comments explaining past bugs
  (`auctionkit/src/auction.ts:344`, `explorer/src/pages/auction.ts:71`) and the
  dev-only key path `.secrets/hoodi-deployer.json` in `fund-plugin.ts`, whose
  `/api/fund` middleware has had no caller since e1d8927.

### Short links and the incentive problem (2026-09-03)

**PealNames is live on Tempo Moderato at
`0x98D1a8b4d8C5d36D5D9a357F7fccE17cB0F63D2f`** (tx
`0x9d55a964032573e1bf6714b1f63860ebed26227d504edcf5553ff9894337c1d7`, 2125 bytes,
gasUsed 2,680,516). `contracts/src/PealNames.sol`, 11 Foundry tests.
- THE ADDRESS IS THE NAMESPACE. Redeploying does not migrate names, it starts a
  second empty registry, so every link anyone shared stops resolving. It lives in
  `packages/explorer/src/live-chain.ts` for that reason, not in an env var.
- A name is claimed once and NEVER moves, not even by the claimer
  (`test_aNameNeverMoves`). That is what makes a shared link safe, and it costs
  reuse: a name spent on a test is spent.
- Links are PATHS, not fragments: `peal.network/shoonya`. This needed no server
  change because `docker/Caddyfile:14` already does `try_files {path} /index.html`.
  In `main.ts`, a hash always wins over the path and the path is then normalised
  away, so navigating off a short link does not leave `/shoonya#/create`.
- GAS TRAP, which cost two failed attempts: `forge script --broadcast` sizes the
  transaction from `eth_estimateGas`, which on Tempo does not account for the
  ~1000 gas per byte of code that foundry.toml already documents. 666,270
  estimated against 2,680,516 actual. `gas_limit` in foundry.toml governs
  SIMULATION only. Use `forge create --gas-limit 29000000`, the repo's own TX_GAS
  value.

**Terms are wire version 2.** The tuple gained `maxMinor`, so it is 8 elements.
A v1 link now fails to unpack rather than being read as uncapped, because a
positional tuple cannot distinguish "no ceiling" from "an older format".

**The incentive answer, since it will come up again.** Nothing escrowed means a
bid is cheap talk, and no in-auction mechanism fixes that. Vickrey does NOT help:
its dominance proof assumes the winner must pay, so with no obligation the
dominant strategy is still to bid infinity and decide later. What was built
instead bounds the damage rather than pretending to solve it:
- a MAXIMUM alongside the reserve, so a joke bid of 99,999,999 cannot take the
  auction. It does not stop somebody bidding exactly the cap, but the cap is a
  number the seller already believes.
- the board is a QUEUE, not a winner. `buildBoard` returns `queue` (inside both
  limits) and `winner` is just `queue[0]`. A bid nobody honours costs the seller
  one line, not the auction.
- the pass-over control is LOCAL to the seller's device
  (`peal-live-passed:<auctionId>`) and says so on screen. Whether somebody paid
  happens off this page entirely; writing it into the shared record would be the
  page claiming to know something it cannot.
Still unbuilt, in order of strength: a rotating stream code committed as
`sha256(seed)` in the terms (proves the bidder was watching, blocks bots), and
optional escrow for bidders who do have a wallet (the only real stake).

**Nav and header.** All links live behind one burger at every width
(`src/nav.ts`, `.site-menu`), opening sideways as a glass pill; the identity
fades while it is out above 900px. Open/closed is a CLASS, never the `hidden`
attribute, because `display: none` cannot transition. The tagline renders only on
`#/` and `#/app` (`body.no-tagline`).

### Peal Live, second pass (2026-09-03)

**Wire versions moved fast, and each bump is deliberate.** Terms are v5 (2 added
the bid ceiling, 3 the picture, 4 the description, 5 the seller's contact key).
The bid record is v2 and 288 bytes. An older link fails to unpack rather than
being read with a field missing: the tuple is positional, so links of different
lengths cannot be told apart by shape, and filling in a default would be
honouring terms nobody agreed to.

**Contact details are encrypted to the seller, not hidden in the UI.** Everything
sealed into a bid is published at reveal, so `packages/live/src/contact.ts` uses
WebCrypto ECDH P-256 + AES-GCM joined by its own `deriveKey`. Public half in the
terms, private half in `localStorage` under `peal-live-key:<auctionId>` on the
creating device only. The private key is THE ONLY COPY: losing that browser
makes every contact unreadable by everyone. Ephemeral key per bid (so two bids
from one person are not linkable), plaintext padded to the cap before encryption
(so length leaks nothing), record fixed at 288 bytes whether or not one is
attached (so the wire does not announce that there was one).

**Growing the record exposed a rule that was only true by accident.** An auction
id length of 255 used to be rejected because it could not fit in 96 bytes; at 288
it fits, so a record claiming one would have decoded an id out of the padding.
`MAX_AUCTION_ID_BYTES` now bounds it in both directions. A limit that holds only
because the buffer is small is not a limit, and it stops being true the moment
the buffer grows.

**The seller is identified by `isHostOf(packed)` in live-recent.ts**, which reads
this browser's own list. It gates an AFFORDANCE, not a permission: everything
behind it is device-local. It exists because the pass-over control used to render
for everyone, and a bidder could press it and be told their own bid was now top.

**The receipt is six hex characters**, shown on the sealed card and beside every
row, so a bidder matches their own row by eye rather than trusting the page. It
replaced a 64-character hash with a copy button that had nowhere to paste.

**`/v0/conditions` now returns `total`.** The list is capped at `LIMIT 100`
(api.rs), so a client counting the array froze at 100 forever, at exactly the
moment there was most to watch. The explorer falls back to `<n>+` against a
coordinator that does not send it.

**Deploy facts.** Railway service is `bte-explorer` with `bte-explorer-volume`
attached and the `peal.network` domain; a failed build leaves the previous
container serving, which is how state survived two bad deploys. Verified live
after a successful deploy: committee `2d7ce50d…` unchanged, 100 conditions.

**Two build traps, both cost real time.** `forge script --broadcast` sizes the tx
from `eth_estimateGas`, which on Tempo ignores the ~1000 gas per byte of code:
666,270 estimated vs 2,680,516 actual, and `gas_limit` in foundry.toml governs
simulation only. Use `forge create --gas-limit 29000000`. And
`ERR_PNPM_IGNORED_BUILDS` was latent for months behind a cached Docker layer:
four `allowBuilds` entries in pnpm-workspace.yaml were the literal string "set
this to true or false".

**Testing note for next time.** Browser tests against a 120s auction race the
close when more than one bidder seals. Use a longer window or poll the condition
status page-side; several apparent product failures were the harness.

## Site honesty pass (2026-09-08, prism single-pass; branch `site-honesty`)

Three reviewer findings, fixed together. Read before touching trust copy or the
developer docs.

**Independence.** The site said "five independent operators" in body copy and
FAQ while the fine print said the committee is a prop. Both true statements,
contradictory together. Rule now (user, 2026-09-08): KEEP the phrase
"independent operators", it is the design and the point is that none of them is
trusted; pair it every time with the devnet caveat, stated separately from the
mainnet commitment. Devnet: five operators we run, one deployment, dealer-generated keys, the
auction committee's signing keys derivable from a published string. Mainnet:
five named, separately operated members under DKG, listed by name before value.
The committee widget (`landing.tsx` CommitteeScene) proves the threshold rule,
not who runs the five; its caption says so. The FAQ answer is mirrored into
`crates/bte-coordinator/src/pages.rs` FAQPage structured data and must move
together. `mempool.ts:844` uses "independent" correctly (per-open work is
independent of batch size); do not sed the word globally.

**Prerendered developer docs.** `/developers*` was the shell plus a script tag
for any reader without JavaScript, which is most agent fetchers. Now
`packages/explorer/scripts/prerender-docs.mjs` runs after `vite build`, loads
`src/prerender.ts` through Vite's SSR loader (import.meta.env resolves; tsx
alone cannot), renders each page with `docsShellHtml` (the same pure function
`renderDocs` uses) and writes `dist/<path>/index.html`. Static sidebar links are
clean paths, which the router also accepts. Production serves those paths from
the coordinator (`names.rs` named_shell/nested_page via Caddy), so
`read_prerendered` prefers the prerendered file and falls back to the shell;
`page_html` still injects title/meta/canonical over it. Test:
`names::tests::prerendered_pages_sit_beside_the_shell_and_never_above_it`.
INVARIANT: keep `PAGES` in `src/prerender.ts`, the router in `main.ts`, and
`pages.rs` in step.

**tlock positioning.** `protocol.ts` compare table gained a drand tlock row (the
old "timelock / VDF" row described a VDF, not tlock) and a "Why not drand tlock"
subsection; `docs/howitworks.ts` gained a comparison table with sources. The
argument is: the condition is yours (deadline or block height, not a beacon
round), the unit is a padded round of 64 (count hiding, one 48-byte share per
operator), HTTP with no chain; and tlock's League of Entropy is the more
independent committee today, said plainly. Grounded facts (research lens,
2026-09-08): tlock = IBE to a drand round, anyone decrypts once the round
signature is public; cadence 3 s quicknet / 30 s default; triggers are round or
duration only, no block height; drand's own applications list matches ours;
not post-quantum by drand's own statement; League of Entropy ~two dozen named
orgs. Paper: "A Simple Batched Threshold Encryption Scheme", Guru-Vamsi
Policharla (Commonware), ePrint 2026/760, sole author; it does NOT position
against drand, and it says decryption still costs a few pairings per ciphertext
in every scheme, so batching is a bandwidth/coordination win, never a compute
win. The pull quote on `mempool-landing.ts` ("addresses the drawbacks of both
per-epoch and per-transaction schemes") was a misquote: it is Shutter's, hedged
("anticipates ... a potential way"), from blog.shutter.network Oct 2025; now
quoted verbatim and attributed. Do not claim Commonware runs a live threshold
mempool (unverified); Shutter does, per-epoch, on Gnosis (footnote 3).

**Brand rule (user, 2026-09-08):** name "batched threshold encryption (BTE)"
explicitly on every outward surface; the product is the primitive.

**Operator names (user, 2026-09-08, reaffirmed over a pushback):** the five
devnet operators carry institution-style names the user chose, Meridian Assay ·
Halcyon Registry · Northwind Trust · Ardent Notary · Vantage Archive
(`short` = first word, for the widget). They are invented; the guardrail is that
`DEVNET_RING_NOTE` ("no organisation by those names operates a node") travels
with every mention, and the limits page and tlock table say it in prose. Mapped
onto wire ids 1..5 in `packages/explorer/src/operators.ts` (single source; the
share log, the committee widget, limits and the tlock table all read it). They
are labels for processes we run, never parties; every surface that shows a
name carries "all run by us" beside it. Real operators replace the list once.

## Telemetry (site honesty pass)
- divergence: 0.80 (evidence 1.00: the two lenses cited disjoint sources, repo
  file:line vs web URLs; conclusion 0.50) | threshold 0.30 UNCALIBRATED
- grounding: n/a (no eval fixtures)
- models: draft=fable · lenses=2x-opus (audience, research); no skeptic panel
  (two-way door)
- claims: independence-contradiction grounded (landing.tsx:760,780,1171) ·
  no-js-shell grounded (names.rs read_shell + Caddyfile @named) ·
  tlock-mechanics supported (drand docs, quoted) · paper-title supported
  (eprint 2026/760) · shutter-misquote supported (blog.shutter.network) ·
  commonware-live-mempool contradicted (struck from copy)
- fleet: 2 lenses + orchestrator implementation

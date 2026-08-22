# 002 — Short share links

Status: proposed (2026-08-22)
Supersedes nothing. Produced by `/prism:prism` — 6 lenses, 4 adversarial verifiers.

## Recommendation

Mint an **8-byte server-issued random code inside `submit_ciphertext`**, return it alongside
`ct_hash`, and resolve it client-side through a new `GET /v0/seals/{code}`. The AES key stays
exactly where it is: in the URL fragment, never in a request line.

```
https://peal.network/#/s/Kx7mQ2pRvNb/XeNhAsUMVQUHJOSnQYDMyw
                         └ 11 chars ┘ └──── 22 chars ────┘
```

**59 characters** for a private seal (from 142), **36** for a public keyless one.

| segment | chars |
|---|---|
| `https://peal.network/` | 21 |
| `#/s/` | 4 |
| code — base64url of 8 random bytes (64 bits) | 11 |
| `/` | 1 |
| key — base64url of the 16-byte AES-128-GCM key, unchanged | 22 |
| **total** | **59** |

The 22-char key is irreducible and is 37% of the budget. Everything else was compressible.

### Why not 64 *bits*

The ask was "under 64 bits." That is not reachable and should not be pursued: the AES-128 key
alone is 128 bits, and 22 base64url characters is already an optimal encoding of it. Shortening
it is a brute-force downgrade on a URL that is public by scraping, offline-attackable forever,
with no salt and no stretching. WebCrypto also accepts only 128/192/256-bit AES keys, so a
96- or 112-bit secret would have to be KDF-stretched back to 128 anyway — same characters, less
strength. The target here is 64 *characters*, and 59 clears it.

## Why

**1. The link's only secret is the key. Everything else was carrying zero bits.**
`conditionId` (29 chars) and `ct_hash` (64 chars) are identifiers, not commitments. The recipient
page uses `ct_hash` for exactly one thing — `reveal.slots.find(s => s.ct_hash === ctHash)`
(`seal-view.ts:162`) — a string equality against a list the coordinator just served. 93 of the
142 characters were redundancy the server can reconstruct.

**2. A server-issued random code is the only shape with no attack surface to reason about.**
The rival design — a truncated `ct_hash` prefix — needs five load-bearing conditions to be safe
(condition scoping, resolve-to-oldest, a `rowid` tiebreak, an `is_dummy` filter, N≥48 bits), each
a place for a later change to reintroduce a hole. A random code the sender does not choose has
nothing to grind, nothing to squat, and no ordering semantics. See the steelman below for the
measurements that killed the prefix.

**3. Minting inside `submit_ciphertext` is atomic and non-breaking.**
The objection to a code was that a separate registration POST leaves a window where the ciphertext
exists but the link resolves to nothing — permanently, since content here has no recovery path.
Minting in the same insert closes that window. And it costs no API break: `seal()` already returns
an object, `{ ctHash, sealedB64 }` (`sdk/src/index.ts:190`), so `code` is an additive field.

## Steelman of the rejected option — the `ct_hash` prefix

**Its strongest case, and it is genuinely strong.** It needs *zero schema change*: `ct_hash` is
already `TEXT PRIMARY KEY` on `ciphertexts` and the row already carries `condition_id`
(`db.rs:27-34`). No new write path, no new column, no migration, no SDK change — one read
endpoint and a regex. It is the cheapest thing that could possibly work, it keeps the link
partially self-describing, and a measured `EXPLAIN QUERY PLAN` confirms the range form
`ct_hash >= ?1 AND ct_hash < ?1 || 'g'` uses the PK autoindex. On pure shipping cost it beats the
recommendation.

**Why it still loses.** `ct_hash` is grindable, and far more cheaply than anyone assumed.
`submit_ciphertext`'s entire validation is `SealedCiphertext::from_bytes` (`api.rs:338`), which
checks magic, type byte, G1 subgroup membership on `ct0`, and length bounds — **`ct1` (128 bits)
and `ct2` (up to 4096 bytes) are never checked** (`wire.rs:395-405`). Fix `ct0` once, vary the
unvalidated tail, and you sample hashes at **3,263,981 candidates/sec on one core** (measured),
one SHA-256 each. That is the same 2-block shape as a Bitcoin block header, so ASIC economics
apply. An honest seal runs at 2,467/sec (measured, criterion, n=5 t=3 B=64, 420µs).

Two tiers follow, and the split is what matters:

| tier | rate | outcome |
|---|---|---|
| junk grind | 3.26M/s | colliding `ct_hash`, but `valid=false`; `seal-view.ts:167` refuses to render it — hijack-to-error |
| valid grind | 2,467/s | genuine content substitution — $1.58M at 48 bits, $10.4B at 64 |

Content substitution is therefore infeasible at N≥48, and condition-scoped resolve-to-oldest
defeats the reactive attack outright (pre-planting is bounded by SQLite insert throughput, not
hash rate: 2^48 stored rows is 56 PB). **The prefix can be made safe.** It is rejected because
"can be made safe, subject to five invariants" is a worse property than "has nothing to attack,"
for a saving of zero characters.

One attack it cannot cleanly shed: **sender equivocation.** The strongest grinder is the sender,
who needs only a birthday collision between two of their *own* seals — ~2^24, not 2^48. Seal A,
then seal B sharing A's prefix; oldest-wins then deterministically points the share link at A
while B is the row in the batch and on-chain. That matters precisely because sealed-bid order
flow is the painkiller in `001-peal-next-plan.md`. A server-issued code has no equivalent.

## What ships

**Coordinator (first, alone).**

1. `db.rs` — additive, matching the existing best-effort `ALTER` pattern for `tag` (`db.rs:76-77`):
   ```sql
   ALTER TABLE ciphertexts ADD COLUMN code TEXT;                    -- .ok()
   CREATE UNIQUE INDEX IF NOT EXISTS idx_cts_code ON ciphertexts(code);
   ```
   Safe on the existing Railway volume: `open()` runs `execute_batch(SCHEMA)` every boot and the
   schema is idempotent by construction. Existing rows keep `code IS NULL`; their old links keep
   working via the retained router branch.
2. `api.rs` `submit_ciphertext` — generate 8 CSPRNG bytes, base64url, insert with the row. Because
   the insert is `INSERT OR IGNORE` on the `ct_hash` PK (`api.rs:356`), a replayed seal must
   **read back the existing code** rather than return a fresh one. Response becomes
   `{"ct_hash": …, "code": …}`.
3. `api.rs` — new route `GET /v0/seals/{code}` → `{condition_id, ct_hash}`. Return 404 on unknown.
   Consider merging the `get_condition` body into the response to save the client a round trip.

**Explorer (second, after verifying the endpoint in prod).**

4. `main.ts:25` — add a short branch *before* the existing regex. The two are unambiguous: the old
   form always has ≥2 segments with a mandatory 64-hex group, which an 11-char base64url token
   cannot match. **Keep the old branch forever** — every 142-char link already in someone's DMs
   resolves with no server round trip, no expiry, and works even if the resolver is down.
5. `main.ts` — resolve the code **once** at mount, then hand `renderSealView` the same
   `(conditionId, ctHash, shareKey)` it takes today. `seal-view.ts` needs zero changes. Do **not**
   put the resolver in the 2s poll loop (`seal-view.ts:234`) — that would hand the coordinator a
   per-recipient heartbeat.
6. `playground.ts:93-95` `sealLink()` — emit the short form; stash `code` on `PlaygroundRun` at
   seal time so the copy button stays instant and never awaits a fetch.
   Also delete the no-op `encodeURIComponent(conditionId)` / `decodeURIComponent` pair — the id is
   already URL-safe hex. Zero characters saved; hygiene only.
7. `home.ts:161` — keyless internal hrefs. Can keep the long form (the router accepts both).

**SDK.** `seal()` returns `code` as an additive field on its existing object. Non-breaking.

**Docs that go stale the moment this lands** (fix in the same pass):
`pages/protocol.ts:373`, `docs/protocol.html:586`, `docs/deploy-railway.md:85`,
`scripts/menubar/bte.30s.sh:10,28,34` (a **live parser** — it string-splits the link and will
break, not merely go stale), `scripts/menubar/README.md:12,18`, `.prism/project-model.md:203,233`.

**Deploy order is not negotiable: coordinator, verify, then explorer.** Frontend-first mints links
against a route that does not exist; those links are dead *forever*, not until the next deploy.
Note `start-railway.sh` treats a missing `params.bin` as first boot and re-runs the ceremony,
which would orphan every existing seal — confirm committee id is stable across the restart.

## Ship alongside — two live bugs this run surfaced

Both are independent of link length. Both were verified by reading the code.

**P1 — the "google calendar" button sends the AES key to google.com.**
`seal-view.ts:81` does `const url = location.href`, fragment and key included, and passes it to
`gcalUrl` (`attention.ts:83-91`), which interpolates it into the `details=` query parameter of
`https://calendar.google.com/calendar/render?…`, rendered as a live `target="_blank"` anchor at
`seal-view.ts:87`. One click transmits the decryption key to Google in a request line. `icsHref`
(`attention.ts:56-79`) writes the same URL into the `URL:` and `DESCRIPTION:` fields of the
downloaded `.ics`, which syncs to whatever calendar service the user imports it into. Nothing
strips the fragment anywhere. This contradicts the claim made verbatim in `privacy.ts:1-4`,
`pages/protocol.ts:376-377`, `docs/protocol.html:588-589` and `docs/how-peal-is-built.html:379`.
The button is rendered in `pendingActions`, i.e. the normal countdown state, for every seal.
**Fix:** build the calendar URL from the keyless base link.

**P2 — the rate limiter is decorative, and the bucket map is an OOM vector.**
`api.rs:96-106` takes the client identity from the first hop of `X-Forwarded-For` with no
trusted-proxy check. Caddy's `reverse_proxy` (`docker/Caddyfile:7`) *appends* the real client IP
to an incoming header, so an attacker-supplied `X-Forwarded-For` arrives first and wins the
`.split(',').next()`. Every request then gets a fresh 400-token bucket. Separately,
`buckets: Mutex<HashMap<String,(f64,i64)>>` (`state.rs:68`) is keyed by that attacker-controlled
string and is **never pruned** — grepped, there is no `retain`/`remove`/`clear` anywhere.
Third, `cors` is the outermost layer and short-circuits `OPTIONS` with `NO_CONTENT` before
`rate_limit` runs, so preflights are unlimited (low severity — they touch no DB).
**Fix:** a trusted-proxy allowlist or take the last hop, plus periodic eviction.

**P3 (lower, own ticket) — `submit_ciphertext` accepts structurally-garbage ciphertexts.**
The FO well-formedness check `ct0 == [H_R(K,msg)]_1` only runs at reveal (`lib.rs:410`), so junk
rides through freeze, occupies real slots in a batch, and surfaces as `valid=false`.

## Assumptions and falsifiers

- **Assumes 64 bits of code is enough against enumeration.** Pre-reveal `ct_hash`es are *not*
  publicly enumerable — `list_conditions` and `get_condition` return counts only, and `get_reveal`
  404s for the whole pending window (`api.rs:541-575`) — so enumeration resistance is a live
  property, not a red herring. At 2^64 with 10⁶ seals registered and 10⁴ rps, expected time to a
  single hit is ~58 years. Falsified if the resolver ever returns anything key-dependent.
- **Assumes the metadata regression is acceptable.** A per-seal lookup tells the coordinator that
  *the holder of seal S opened it at time T from IP I* — a log with no equivalent today. It is
  smaller than it first appears, because `seal-view.ts` already polls `getCondition(conditionId)`
  every 2s, which is already a per-recipient heartbeat for a single-seal capsule. Falsified if you
  ever want recipient-anonymous reads, in which case keep the long form as the default.
- **Assumes coordinator-trust is already the status quo, so the resolver adds none.** Verified:
  `seal-view.ts` never imports `verify.ts` — the sole importer is `pages/condition.ts:14`. The
  recipient page performs no on-chain check, no re-hash of `sealed_b64`, no merkle check. Falsified
  the day someone ships independent verification into the seal page; at that point the link should
  carry a real commitment again, and this decision should be revisited.
- **Not assumed: that shortening helps on X.** It does not. `t.co` rewrites every link to a fixed
  23-character weight regardless of length. The real justification is email and quoted-text
  wrapping: RFC 5322 wraps at 78 columns, quoted-printable hard-wraps at 76, and a 142-char link
  wraps *inside the key segment*. `seal-view.ts:189-190` already ships the error string for this,
  which means it has happened. Under 64 survives a send plus one level of `> ` quoting.

## Open questions for the human

1. **Resolver durability.** A short link adds a resolver dependency to content that has no
   recovery path. The mitigation is that the mapping lives in the same row as the ciphertext, so a
   restore recovers both — but tokens must then be append-only and never expire. Confirm you want
   that permanence.
2. **Do you want the canonical long link surfaced anywhere?** Recommendation: not as a second
   button of equal weight, but as selectable text on the seal card labelled for what it is — an
   archival artifact that works without the resolver.
3. **P1 severity call.** The Google Calendar leak is live in production today. Ship the fix ahead
   of this work, or bundled with it?

## Telemetry

- divergence: 0.73 (evidence 0.75, conclusion 0.70) | threshold 0.30 UNCALIBRATED
- grounding: n/a (no eval fixtures this run)
- models: draft=opus · skeptics=2x-opus + 1x-sonnet (cross-tier; version axis unavailable)
- claims: seal-rate-2467/s **verified** (criterion benchmark run) · junk-grind-3.26M/s **verified**
  (probe run) · ct1/ct2-unvalidated **verified** (`wire.rs:395-405`) · gcal-key-leak **verified**
  (re-read `seal-view.ts:81`, `attention.ts:83-91`) · xff-bypass **verified** (re-read
  `api.rs:96-106`, `docker/Caddyfile:7`) · buckets-unpruned **verified** (grep, no eviction) ·
  seal-view-never-imports-verify **verified** (`pages/condition.ts:14` sole importer) ·
  pre-reveal-hashes-not-enumerable **verified** (`api.rs:541-575`) · sdk-seal-returns-object
  **verified** (`sdk/src/index.ts:190`) · redirect-drops-fragment **supported** (RFC 9110 §10.2.2
  quoted; not tested in a browser) · 64-bit-code-enumeration-margin **unverified** (arithmetic on
  an estimated seal count)
- casualties: prefix-preserves-verifiability **contradicted** · index-already-public
  **contradicted** · self-contained-63-char-design **contradicted** (breaks public keyless seals) ·
  no-ASIC-shortcut **contradicted** (measured 1,323× faster than assumed)
- fleet: 6 lenses + 4 verifiers (1 relaunched, 1 stalled and completed by hand)

> Cross-tier verification reduces instance- and tier-level error correlation but not
> shared-lineage blind spots. Treat cross-tier survival as weaker evidence than grounding.

## Changelog

Round 1 produced four different recommendations at 47/56/60/63 chars. The verify pass killed three
of them: the `ct_hash`-prefix family (grindable at 3.26M/s, plus sender equivocation at 2^24), the
self-contained packed blob (cannot address a slot for public keyless seals, which ship today from
`home.ts:161`), and the HKDF-seed design (buys 9 chars by deriving the lookup handle from key
material, for no product gain, on a WebCrypto path with no authoritative per-browser support row).
Two claims the panel asserted were refuted outright: that a prefix preserves recipient-side
verifiability, and that the seal index is already public. Both had been load-bearing.

# 004 — Post-quantum Bitcoin ownership commitments: pressure test

**Date:** 2026-08-30 · **Status:** assessment, no build authorised
**Method:** prism PLAN, 8 lenses + 7 adversarial skeptics (2×Opus + 1×Sonnet per decisive claim)

## Recommendation

The instinct is right. The mechanism is wrong. It is not a company.

A timestamped, pre-quantum artifact really is the only handle on coins with no
knowledge asymmetry — and BIP-361's own current text endorses exactly that
approach. But "time-bound encryption opening in 100 years" is the wrong
primitive and no post-quantum version of it exists. The commitment-plus-
timestamp branch is public prior art since February 2026, so there is no
novelty claim and no moat in restating it.

One question in this space is genuinely unanswered, and it is the one the
SealBid dispute-window work already solves. That is the contribution.

## What the panel overturned

Two of the biggest claims died under refutation. Both were mine to check.

**"BIP-361 Phase C already solves this with a ZK proof of BIP-39 seed
knowledge."** REFUTED by two independent skeptics. Phase C was **deleted** from
BIP-361 by commit `ab2ebe2` ("Corrections to BIP-0361 on rescue protocols"),
three days after the merge, along with every BIP-39 reference. The live BIP has
two phases. The asymmetry it now relies on is **BIP-32 hardened derivation**,
not seeds. Journalist coverage and bip361.org still describe the superseded
draft.

**"Harvested-key laundering is fatal."** REFUTED as fatal. A thief holding a key
today can already take the coins with certainty; the scheme adds an option worth
~0.0008× that, so it cannot make theft "strictly" more profitable. The
populations are anti-correlated: compromise happens through active use, dormancy
implies non-use. It survives as a legitimacy concern, not a kill shot.

## What is verified true

- **PACTs is real.** Dan Robinson, Paradigm, 2026-05-01, *"PACTs: Protecting
  Your Bitcoin From a Quantum Sunset"*. `commitment = SHA256("PACT/v1
  commitment" ‖ salt ‖ SHA256(control_proof))`, BIP-322 full proof, anchored via
  OpenTimestamps, redeemed with a STARK. Free. Explicitly motivated by seedless
  pre-BIP-32 coins — so the "seedless gap" is occupied, not open.
- **Earlier prior art than Paradigm:** olkurbatov, Delving Bitcoin, 2026-02-25
  (OTS-timestamped commitments + off-chain registry); Jeremy Rubin, 2026-04-15
  (commit-reveal for PQ migration, which PACTs cites); Ruffing eprint 2025/1307;
  Kiraz & Kardas eprint 2026/352 (STARK for seedless coinbase UTXOs, proposes
  `OP_CHECKQUANTUMSIG`/`OP_CHECKSTARKPROOF`); Sattath & Wyborski eprint 2023/362.
- **Nobody is shipping.** GitHub search for PACT implementations: zero results.
  Every proposal needs a soft fork that does not exist. The space is *blocked*,
  not occupied.
- **No post-quantum timelock encryption exists.** drand `tlock` is
  Boneh-Franklin IBE over BLS12-381 pairings; drand's own docs say it is not
  quantum resistant. RSW puzzles fall to Shor via factoring. Class-group VDFs
  fall to Biasse-Song. Sequential-hashing PoSW is PQ-secure but cannot hide a
  self-opening secret. Isogeny timed commitments (eprint 2026/057) are
  research-only.
- **BLS12-381 is Shor-broken** — the same discrete-log family as ECDSA. Our
  stack (`simple-bte`, Cargo.toml:19) is not reusable for a PQ product and must
  not be positioned as PQ expertise.

## The one open problem

**Competing and duplicate claims on the same UTXO is unanalysed everywhere.**

- PACTs' own "Risks and Downsides" covers non-adoption and multisig
  standardisation — nothing on two PACTs for one output.
- In Rubin's thread, Brandon Black asked *"How would someone prove the age of
  their pre-commitment?"* and received no answer.
- Grep of eprint 2026/352: `earliest`, `competing`, `dispute`, `claimant` —
  zero hits.

We have already built and shipped the answer, in a different domain:
`docs/auctionkit/decisions/0004-void-and-dispute.md`. A mismatched claim voids
itself rather than halting the system; disputes resolve to nobody rather than to
the fastest party. Applied here:

1. **A spend supersedes any commitment.** A live owner destroys a thief's claim
   with one transaction, any time before the flag day.
2. **Contested claims pay nobody** — freeze or burn, never rank by timestamp.
   This sets an opportunistic claimant's EV to exactly zero.
3. **Public, address-linked commitments** turn a silent key compromise into a
   detected one, decades before redemption.

That is a real, defensible contribution to an open question, and it is
downstream of work already done.

## A second technical finding worth writing up

BIP-361's post-correction asymmetry rests on hardened derivation, and that has a
hole. For non-hardened children, `k_i = parse256(IL) + k_par mod n` where
`IL = HMAC-SHA512(c_par, serP(K_par) ‖ i)`. An xpub gives the chain code and
parent pubkey; Shor gives every child privkey from any exposed pubkey; therefore
`k_par = k_i − IL`. Chain codes are routinely public via watch-only exports and
multisig registration. Under BIP-44/84/86 hardening stops at account level, so a
published account xpub plus Shor yields the account xpriv — the very secret the
rescue proof attests. A sound proof must reach above the hardened boundary and
bind to the sighash, or it is strippable and replayable.

## Urgency is real, and inverted from the usual framing

The "no rush, freeze is 2032-34" reading is backwards. Bitcoin's *earliest
possible completed* migration sits at or beyond the point where the attack
arrives:

| | |
|---|---|
| NIST IR 8547 (still **Initial Public Draft**, no final) | secp256k1 is a 128-bit curve: **"Disallowed after 2035", no 2030 deprecation**. The widely-repeated "deprecated 2030" is the *112-bit* row — the error appears in BIP-360's own motivation text |
| IBM Starling | 200 logical qubits, 100M gates — 2029 |
| IonQ | 80,000 logical qubits claimed by 2030 |
| ECDLP-256 cost | 2,330 logical qubits (2017) → 835 (2026); Toffolis 1.3e11 → <9e7 |
| Forecasts | ~2030-2040, clustering **2032-2035**, ~15% tail before 2031 |
| On-spend window | first half of the attack is precomputable, so key-reveal-to-break is **~9 min against a 10 min block** |

Meanwhile BIP-361 is `Status: Draft`, `Requires: TBD Post Quantum Signature
BIP` — a BIP that does not exist. No PQ code has merged into Core. CTV's base
rate is 6.5 years without activation.

**The single largest unowned item is that missing PQ signature BIP.** Announced
13 months ago, never filed.

Two cautions on numbers everyone repeats: Webber et al.'s "13 million qubits" is
stale (it maps a 2017 circuit onto 2021 hardware, inheriting a ~1,500x larger
Toffoli count), and every expert survey is calibrated to **RSA-2048** while
ECDLP-256 is 1-2 orders of magnitude cheaper — so all of them lag for Bitcoin.
Counterweight: zero production logical qubits exist anywhere, Google's best
logical error rate is ~1e-3, and no roadmap but IBM Blue Jay (2033+) publishes a
number clearing ~1,200 logical qubits.

## The better market, found last

The largest tranche of exposed BTC needs **no cryptography research at all**.

| | |
|---|---|
| Exchange balances exposed | **1.63-1.66M BTC — ~40% of all operationally-unsafe BTC** |
| Bitfinex, Robinhood | **100% exposed** |
| Binance | 85% · Grayscale ~50% |
| Coinbase | **5%** · Fidelity ~2% · CashApp ~2% |

A 100%-vs-5% spread across venues means this is **key hygiene already solved by
some custodians**, not a protocol problem. It is a far better-defined market than
a recovery scheme gated on a freeze that may never activate, and it needs no soft
fork, no ZK circuit, and no consensus change.

Supply, properly split (do not quote "30% vulnerable" flat — it overstates
standing risk ~2.5x):

| Bucket | Amount | Note |
|---|---|---|
| P2PK | **~1.72M BTC across ~20,000 pubkeys** | small, enumerable; owners gone; not soft-fork fixable |
| Address reuse | ~4.1-5.0M BTC | mostly **live, identifiable owners** |
| P2TR | ~147-205K BTC | exposed at rest, but **soft-fork fixable** by disabling key-path spend |
| Irreducibly at risk | **~2.3M BTC** | no rescue protocol can save these |

## Why it is not a business

- No regulator requires it. MiCA, SEC, OCC, SAB 122 term scans: clean. No NYDFS
  quantum letter exists. G7 and CNSA both explicitly disclaim setting
  expectations for anyone outside their scope.
- EDPB Guidelines 02/2025 (final, 2026-07-07) land directly on the architecture:
  *"the hash will also be considered personal data"*, verification data should be
  *"kept outside of the blockchain"*, and *"as a general rule, storing personal
  data on a blockchain should be avoided."*
- Anyone who can *commit* can also *spend*, and spending strictly dominates. The
  addressable set is people who can act but won't — thin, and structurally
  disinclined to pay in advance.
- Real insurance is impossible: no reinsurer writes a 20-year BTC-denominated
  tail contingent on a governance vote. Insurance *language* without a balance
  sheet is a regulatory problem, not a business model.
- A token is a claim on a redemption event that may never occur.

Only watch item: the US Treasury Quantum-Readiness Task Force (announced
2026-08-24) has a "Digital Assets and Emerging Technology Risk" workstream. Six
days old, nothing published.

## Vocabulary that must change before this is said out loud

| Said | Should be |
|---|---|
| "ECDSA will not exist" | a sunset invalidates legacy discrete-log signatures — ECDSA *and* Schnorr |
| "accounts convert" | owners move UTXOs to PQ outputs (Bitcoin has UTXOs, not accounts) |
| "don't put it on chain, it leaks" | the pubkey leaks at spend; a salted hash leaks nothing — anchor it for ordering |
| "time-bound encryption" | commitment + timestamp |
| "100 years" | before the Phase B deadline |
| "prove they spent before" | delete — the chain already proves this |
| Satoshi as the example | a 2013 P2PKH holder; BIP-361 says no rescue is believed possible for P2PK |

## Design constraints if anything is ever built

- Anchor on-chain via OpenTimestamps; **upgrade the `.ots` to complete before it
  leaves your hands** — a pending attestation is a pointer to a calendar server,
  not a Bitcoin path, and is a silent total loss if the calendar dies.
- Commit to bytes, never to a circuit or verification key, so the proof system
  stays swappable for decades.
- Dual-hash (`SHA256 ‖ SHA3-256`) buys agility with no liveness assumption,
  which beats RFC 4998 re-timestamping — that requires periodic action and
  breaks the set-and-forget premise.
- Rigid, canonical preimage encoding with domain separation. No attacker-
  controlled slack.
- No threshold committee, server, or liveness assumption survives the horizon.
  Our own re-timestamping service would be a liveness assumption too.
- Never a Pedersen/EC commitment — perfectly hiding but DLog-binding, so a
  quantum adversary equivocates to any key.

## Telemetry

- divergence: 0.74 (evidence 0.90, conclusion 0.50) | threshold 0.30 UNCALIBRATED
- models: lenses=8×opus · skeptics=2×opus+1×sonnet per decisive claim (cross-tier; version axis unavailable)
- claims: PACTs-exists **grounded** (primary source fetched twice independently) ·
  phase-c-deleted **grounded** (commit ab2ebe2 + live BIP text) ·
  no-pq-timelock **grounded** (drand docs verbatim + eprint) ·
  harvested-key-fatal **contradicted** (refuted) ·
  seed-asymmetry-solves-it **contradicted** (refuted) ·
  priority-problem-unanalysed **supported** (three independent negative greps) ·
  bls12-381-shor-broken **verified** (Cargo.toml:19 + literature)
- evidence: 7 verified, 9 supported, 3 unverified, 2 contradicted
- fleet: 8 lenses + 7 skeptics; 1 lens (practitioner) did not return, scope covered by others
- caveat: several agents exhausted their web-search budget; 2026 arXiv items are preprints
- **self-corrected post-hoc:** the NIST "deprecated after 2030" row was the 112-bit
  entry, not secp256k1's; IR 8547 is still IPD. Fixed above.
- **do not repeat:** a Murch "authoritarian and confiscatory" quote circulated in
  this run's sources appears **nowhere in the primary record** — treat as fabricated.
  Also unverified: CoinShares' 10,200 BTC figure, all Project Eleven numbers.

> Cross-tier verification reduces instance- and tier-level error correlation but not
> shared-lineage blind spots. Treat cross-tier survival as weaker evidence than grounding.

# Peal on Solana

A Solana program that anchors Peal reveal roots and verifies inclusion proofs
onchain, plus the localnet harnesses that prove it does both.

Self-contained. It is not a member of the root cargo workspace or the pnpm
workspace, so building or testing anything else in this repo is unaffected by
this directory existing.

## Why this is small

Peal is already almost entirely chain agnostic, which is the real finding and
worth stating before the code. `bte-sdk` has no dependencies at all. The
coordinator and `bte-node` are Rust over HTTP. `simple-bte` and arkworks never
touch a chain. Sealing, partial decryption, `pre_decrypt`, `combine` and
`finalize` do not know what an EVM is.

Four things were EVM-shaped, and only the last is large:

| | |
|---|---|
| `packages/sdk/src/anchor.ts` | one file, hand-rolled selectors, no viem |
| `crates/bte-coordinator/src/engine.rs:98-113` | `eth_blockNumber` for the `at_block` cue |
| `crates/bte-coordinator/src/eip712.rs` | EIP-712 digests, would become ed25519 |
| `contracts/` | 1555 lines of Solidity, 809 of them `SealedBidAuction.sol` |

This directory does the first of those. The auction port is the real work and
is not started.

## What the program does

`peal-anchor` is the counterpart of `contracts/src/BteAnchor.sol`, with one
capability the Solidity version does not have.

- `Initialize` records the coordinator in a config PDA. Once.
- `Commit` logs a ciphertext hash against a condition. No accounts, open to
  anyone, exactly like `BteAnchor.commit`.
- `RevealRoot` writes the merkle root and leaf count to a PDA derived from the
  condition id. Coordinator only, once per condition.
- `VerifyInclusion` checks a payload against the anchored root **onchain**.

`BteAnchor` stores a root and leaves proof checking to `verifyAnchor` offchain.
Here it runs onchain, because sha256 is a syscall on Solana and a tree walk is
a few thousand compute units. Another program can therefore make a decision
that depends on a specific payload having been in a specific sealed batch, by
CPI, without trusting an offchain verifier.

## What it deliberately does not do

**It holds no funds.** No escrow, no allocation, no settlement. Every account it
owns is 69 bytes of condition id, root and count. If this program is wrong, an
anchor becomes unusable; money does not move.

**It does not verify threshold decryption shares.** That needs BLS12-381
pairings. Solana's pairing syscall arrives with SIMD-0388, whose
`sol_curve_pairing_map` accepts at most 8 pairs. Peal's share check is
`e(pd_j, -g_2) * prod_i e(ct_{i,0}, v_j^i) == 1`, which is `1 + B` terms and so
65 at `B = 64`: nine syscalls plus Fp12 accumulation, at compute costs the SIMD
does not specify, behind a feature gate whose mainnet status is not confirmed.
This is the same shape as the Vara finding, and it gets the same answer. Share
verification stays on Ethereum, where EIP-2537 makes it 6.5M gas and where it
was actually measured. See `docs/auctionkit/decisions/0003`.

**It does not enforce the reveal deadline.** Nothing here reads a clock. A root
appears when the coordinator sends one. That is exactly the position the EVM
anchor is in, and it is a live invariant in `.prism/project-model.md`: the
deadline is asserted by the coordinator, not enforced by the protocol.
Anchoring on a second chain does not change that, and this directory should not
be read as progress against it.

## The property that matters

The root computed here must be byte-identical to
`crates/bte-coordinator/src/merkle.rs`. One byte of difference is not a smaller
error than total nonsense: every proof is rejected and the anchor quietly stops
meaning anything.

So `leaves_and_roots_match_the_coordinator_exactly` pins values produced by
compiling the coordinator's own `merkle.rs` and printing its output, then
reproduced independently through the browser path in
`packages/explorer/src/merkle.ts`. Both agreed byte for byte. The values are
pinned rather than recomputed by a helper next door, because a second
implementation living beside the first will happily agree with itself and
disagree with the chain.

Three conventions have to match and each is easy to get subtly wrong:

- **Position is little-endian u32.** The EVM side of this repo is big-endian
  everywhere, so the instinct to write `to_be_bytes` is strong and wrong.
- **Pairs are not sorted.** AuctionKit's *reveal* tree uses OpenZeppelin's
  `MerkleProof`, which hashes `(min, max)`. This tree hashes `(left, right)` in
  position order. Two different trees in one repo; confusing them produces
  roots that look plausible.
- **An odd node is promoted, not duplicated.** Duplicating is a known way to
  make two different leaf sets share a root.

## Measured cost

On a local validator, Agave 4.2.1, SBPF v3:

| instruction | compute units |
|---|---|
| `Initialize` | 6,951 |
| `Commit` | 703 |
| `RevealRoot` | 9,285 to 12,285 |
| `VerifyInclusion` | 1,355 + 170 per level |

which puts a proof for one bid in a 512-bid batch at **2,897 CU**, against a
200,000 CU default instruction budget. Reproduce with `localnet/measure.mjs`.

Two things in that table are worth reading properly.

`RevealRoot`'s spread is not batch size. It is `find_program_address` searching
bump seeds, quantised at roughly 1500 CU per iteration, and it depends only on
the condition id. The first measurement run had this cost swamping
`VerifyInclusion` so badly that a 64-leaf batch appeared to verify *cheaper*
than an 8-leaf one. That is why the reveal record stores its own condition id:
thirty-two bytes of rent buys a read path that derives nothing, and reads are
the hot path. Writes still pay for canonicity.

`VerifyInclusion` is flat and linear because of that change, and reproduces to
the exact CU across runs.

## Build and test

```
cd solana/peal-anchor
cargo test --features no-entrypoint --lib     # 11 tests, no validator needed
cargo-build-sbf --arch v3                     # -> target/deploy/peal_anchor.so
```

`--arch v3` is required. The `cargo-build-sbf` default is `v0`, which current
runtimes refuse with "Detected sbpf_version required by the executable which are
not enabled".

Then, against a validator:

```
solana-test-validator --reset
solana program deploy target/deploy/peal_anchor.so

cd ../localnet && npm install
node guards.mjs <PROGRAM_ID>      # 16 assertions
node measure.mjs <PROGRAM_ID>     # the table above
```

The unit tests prove the tree agrees with the coordinator. They cannot prove the
program refuses what it should refuse, because those refusals live in account
ownership, signer checks and PDA derivation, none of which exist outside a
runtime. Hence two suites.

## Two constraints worth knowing before extending it

**Solana does not type accounts for you.** The caller chooses every account the
program receives. Each handler re-derives the PDA it expects and compares, or
checks ownership plus a tag byte plus the stored condition id. A Solidity
mapping determines its own slot from the key; an account reference determines
nothing.

**A reveal PDA's address is public as soon as the condition id is.** Anyone can
compute where a future reveal will live and send it lamports, and
`create_account` fails outright on a funded address. Under a naive
implementation that permanently blocks a condition from ever being anchored, for
the price of one rent-exempt transfer. `create_pda` falls back to transfer,
allocate and assign, and `guards.mjs` performs the grief and then anchors
anyway.

## Not deployed

Localnet only. No devnet or mainnet deployment, no program authority
arrangement, and no client wiring: nothing in `packages/` or `crates/` imports
any of this, and nothing outside this directory changed.

The honest next step is not more of this program. It is deciding which single
chain SealBid ships on, because `grep -rni bte packages/auctionkit/src/` still
returns nothing and the cue is still unenforced. A second chain does not close
either hole; it duplicates both.

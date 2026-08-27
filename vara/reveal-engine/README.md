# Peal reveal engine

A Vara.eth program that recomputes AuctionKit's reveal root, so the committee's
arithmetic can be checked instead of trusted.

## The problem it addresses

The committee builds a merkle root over every revealed bid, signs it, and posts
it to Ethereum. `registerRevealRoot` checks the signatures. It cannot check the
arithmetic. A committee that builds the tree wrongly, or omits a bid, produces a
root that is correctly signed and wrong, and the only thing that catches it is a
bidder noticing their own bid was voided and calling `disputeVoid`.

This program recomputes the root from the revealed bids where anyone can query
it, and refuses to produce one until every bid the Ethereum contract says was
committed has been submitted.

## What it deliberately does not do

**It holds no funds.** Escrow, allocation and refunds stay in the Ethereum
contract. That is Gear's own recommended pattern for anything carrying value:
*"funds stay in Solidity until a Vara.eth callback confirms release, refund, or
cancel"* (`examples/escrow/README.md` in gear-foundation/vara-eth-skills).

**It does not verify threshold shares.** That needs BLS12-381 pairings. Measured
against gear's gas ceiling, a batch of 64 costs 3.83e12 against a hard limit of
1e12 that funding cannot raise, and `gr_crypto` (gear-tech/gear #5582) is still
draft with placeholder weights. Share verification stays on Ethereum, where
EIP-2537 makes it 6.5M gas. See `docs/auctionkit/decisions/0003`.

## The property that matters

The root must be byte-identical to what `SealedBidAuction` verifies. One byte of
difference is not a smaller error than total nonsense: every proof is rejected,
every bid is voided, every bidder is refunded instead of allocated.

So `leaves_and_root_match_solidity_exactly` pins values printed by
`contracts/test/auctionkit/RevealVectors.t.sol`, which calls the same
`revealLeaf` the deployed auction uses. Two conventions have to match and both
are easy to get subtly wrong:

- the leaf is double hashed, `keccak256(keccak256(abi.encode(...)))`
- pairs are sorted before hashing, as OpenZeppelin's `MerkleProof` does, not
  left-to-right. Left-to-right is wrong for about half of all trees, which is
  worse than always wrong because it looks intermittent.

## Build

```
cd vara/reveal-engine
cargo build                      # wasm + IDL
cargo test -p peal-reveal-engine-app --lib
```

Produces `target/wasm32-gear/debug/peal_reveal_engine.opt.wasm` (~146 KB) and
`peal_reveal_engine.idl`.

Its own cargo workspace: edition 2024 targeting `wasm32v1-none` under `no_std`,
where the main Peal workspace is edition 2021 for native targets.

## Two constraints worth knowing before extending it

**Exported signatures must be expressible in Solidity's ABI**, because Solidity
calls into them. A Rust struct cannot cross that boundary, so `RevealedBid`
stays internal and `add_bids` takes parallel arrays the way a Solidity function
would.

**Salts arrive as one flat `bytes`, 32 per bid**, not as `bytes32[]`. A plain
`[u8; 32]` has no `SolValue` impl so it cannot cross the Solidity ABI, and
alloy's `FixedBytes<32>` has no SCALE `Decode` so it cannot cross the native
one. `bytes` is the one shape both encodings accept.

## Not deployed

Deploying needs the `ethexe` CLI and wVARA for the program's executable balance,
neither of which is set up here. The program builds, its IDL generates, and its
logic is tested against Solidity ground truth.

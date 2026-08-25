# 0002 — Domain separation lives inside the plaintext

**Status:** accepted · **Date:** 2026-08-25

## Context

`seal(params, payload, rng)` (`crates/bte-crypto/src/lib.rs:169`) takes **no
associated data**. It calls `simple_bte::bte::fo::encrypt(&params.ek, payload,
rng)` and nothing else. There is no AAD parameter, no epoch binding, no context
string anywhere in the envelope.

AuctionKit needs bids bound to a specific chain, auction, batch and epoch, or a
ciphertext from one auction could be replayed into another.

The engineering rules forbid introducing new cryptographic algorithms or
modifying reviewed crypto code, so adding AAD to the scheme is out of scope.

## Decision

Carry the context **inside the plaintext** and verify it after decryption. Every
bid payload embeds:

```
protocol name + version, chainId, auction contract, auctionId,
batchIndex, bidId, encryptionEpoch
```

The reveal path rejects any decrypted bid whose embedded context does not match
the auction it was decrypted for.

Independently, the onchain `BidCommitment` typehash binds `chainId`, the auction
address, `bidId`, `bidder`, `quantity`, `maxPriceTick`, `salt` and `bidVersion`
using `abi.encode` — never `encodePacked`, which is ambiguous for dynamic values.

## Consequences

This is **detection, not prevention**, and the difference should be stated
plainly:

- A ciphertext from auction A *can* be submitted into auction B's batch. Nothing
  stops it at submit time, because at submit time nobody can read it.
- At reveal it fails: its embedded context does not match, so it is rejected.
- It also cannot be matched to a valid onchain commitment in auction B, because
  that commitment binds the auction address and chain id.

So a replay costs the attacker a wasted batch slot and an escrow they get
refunded. It cannot corrupt a result.

## When to revisit

If `bte-crypto` ever gains an AAD parameter — which would be a change to
`simple-bte`, not to this repository — the binding should move into the envelope
where it prevents rather than detects.

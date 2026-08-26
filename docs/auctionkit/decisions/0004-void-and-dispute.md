# 0004 — Voiding a mismatched bid, and the dispute that keeps it honest

**Status:** accepted · **Date:** 2026-08-26

## The bug

`bidCommitment` bound `bidId`. The contract assigns `bidId = committedBidCount`
inside `commitBid`, so a bidder could only bind it by reading the counter first
and hoping nobody landed in between. Two wallets in the same block read the same
value; one committed to an id that was never theirs.

The consequence was far worse than a lost bid. `processReveals` **reverted** on a
commitment mismatch, and `finalize` requires `processedBidCount ==
committedBidCount`. So a bid that could never be processed meant an auction that
could never settle — it ran to `failOnRevealTimeout` and refunded everyone.

And `commitBid` cannot inspect a commitment. That is what makes a bid sealed.
So there was nothing to reject at commit time, and **anyone could post
`keccak256("junk")` with one wei of escrow and permanently halt any auction for
the price of gas.**

Funds were never at risk; the refund path is objective and works. But no auction
could complete if anyone wanted to stop it.

Pinned in `contracts/test/auctionkit/BidIdRace.t.sol`.

## Fix, part 1: `bidId` leaves the commitment

Nothing was lost. `bidder` is still bound, and `bids[bidId].bidder` is what the
reveal checks against, so a commitment still cannot be moved to another account.
A bidder can now compute their commitment from values they already hold, which
is what a commitment should always have been.

## Fix, part 2: a mismatch voids that bid instead of halting the auction

A mismatch is the bidder's problem, not the auction's. The bid is marked
`voided`, contributes no demand, and its escrow stays fully refundable through
the normal `claim` path.

The merkle proof requirement is unchanged and still reverts. It is what proves
the committee actually attested something for this bid, so omission remains a
halt — the property `RevealIncomplete` exists for.

## The problem that fix created, and part 3

Voiding on its own hands the committee a censorship button: attest the wrong
plaintext for a bidder you dislike, and they are quietly dropped while the
auction settles without them. `test_committeeCannotSubstituteADifferentPlaintext`
caught this immediately — it started failing, which is exactly what it is for.
Rewriting that test to accept the weaker behaviour would have been the wrong
move.

The contract cannot tell a junk commitment from a substituted plaintext. Both
are just a mismatch. But the **bidder** can, because only they hold a preimage
matching what they posted.

So `disputeVoid(bidId, quantity, tick, salt, bidVersion)` recomputes the
commitment from a supplied preimage. If it matches, the commitment was
well-formed, therefore the attested leaf was not the bidder's, therefore the
committee attested something false. The auction halts and everyone is refunded.

A halt rather than a correction: a committee that attested one wrong leaf has no
claim to be trusted on the others. The signed root makes it attributable
afterwards.

A griefer cannot use this. They have no preimage for a commitment they invented,
which is precisely why their bid was voided.

## `VOID_DISPUTE_WINDOW`

Settlement waits `1 hours` after the last void, or the committee could void and
finalize in the same block and leave no window to dispute. Auctions where every
bid matched — the ordinary case — settle with no delay at all.

This needed one more constraint. With a short reveal window the dispute window
could outlast it, so a late void would leave no time to finalize and the
griefing vector would be back. `initialize` now requires
`revealDeadline >= endTime + VOID_DISPUTE_WINDOW`.

## What is still trusted

A committee that stalls `processReveals` until the deadline still halts the
auction. That is not new and not fixed here — it is the same liveness assumption
as [0001](./0001-reveal-root.md), with the same objective recovery through
`failOnRevealTimeout`.

[0003](./0003-onchain-share-verification.md) is what eventually shrinks this:
onchain share verification makes a valid share its own attestation.

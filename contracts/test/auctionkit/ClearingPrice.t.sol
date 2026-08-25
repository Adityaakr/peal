// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingPrice} from "../../src/auctionkit/ClearingPrice.sol";
import {AuctionMath} from "../../src/auctionkit/AuctionMath.sol";

/// Slice 3: the auction mathematics, tested with no tokens, no storage and no
/// access control in the picture.
///
/// The properties below are the ones a bidder is actually relying on. If any of
/// them can be broken, no amount of correct plumbing elsewhere saves the
/// product — someone's money goes to the wrong place and nothing reverts.
/// Internal library calls are inlined into the test, so `vm.expectRevert` has no
/// call boundary to observe. This harness gives the guard tests one.
contract ClearingPriceHarness {
    function findClearingTick(uint256[] memory demandByTick, uint256 supply)
        external
        pure
        returns (ClearingPrice.Result memory)
    {
        return ClearingPrice.findClearingTick(demandByTick, supply);
    }
}

contract ClearingPriceTest is Test {
    using ClearingPrice for ClearingPrice.Result;

    uint8 constant SALE_DECIMALS = 18;
    uint256 constant ONE = 1e18;

    ClearingPriceHarness harness;

    function setUp() public {
        harness = new ClearingPriceHarness();
    }

    function _demand(uint256 numTicks) internal pure returns (uint256[] memory) {
        return new uint256[](numTicks);
    }

    // ---------------------------------------------------------------------
    // The deterministic reference example from the specification.
    //
    //   supply 100
    //   A: 50 @ 2.00     B: 70 @ 1.50     C: 100 @ 1.00
    //   => clearing 1.50, A gets 50, B gets 50, C gets 0
    //
    // Reserve 1.00, tick size 0.50, so tick 0 = 1.00, tick 1 = 1.50, tick 2 = 2.00.
    // ---------------------------------------------------------------------
    function test_referenceExample() public pure {
        uint256[] memory d = _demand(3);
        d[2] = 50 * ONE; // A
        d[1] = 70 * ONE; // B
        d[0] = 100 * ONE; // C

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);

        assertTrue(r.cleared, "must clear");
        assertEq(r.clearingTick, 1, "clearing tick is 1.50");
        assertEq(r.supplySold, 100 * ONE, "all supply sold");

        // A is above the clearing tick: filled in full.
        assertEq(ClearingPrice.allocationFor(r, 50 * ONE, 2), 50 * ONE, "A gets 50");
        // B is at it, and 70 of demand chases 50 of remaining supply.
        assertEq(ClearingPrice.allocationFor(r, 70 * ONE, 1), 50 * ONE, "B gets 50");
        // C is below it.
        assertEq(ClearingPrice.allocationFor(r, 100 * ONE, 0), 0, "C gets 0");

        // Both winners pay the same 1.50, not their own maximums.
        uint256 price = AuctionMath.priceAt(1e6, 5e5, r.clearingTick); // 6-dp quote
        assertEq(price, 1_500_000, "clearing price is 1.50 USDC");
        assertEq(AuctionMath.costFloor(50 * ONE, price, SALE_DECIMALS), 75_000_000, "A pays 75 USDC");
        assertEq(AuctionMath.costFloor(50 * ONE, price, SALE_DECIMALS), 75_000_000, "B pays 75 USDC");

        // A bid 2.00 and pays 1.50: the escrow difference is refundable.
        uint256 aEscrow = AuctionMath.escrowFor(50 * ONE, 1e6, 5e5, 2, SALE_DECIMALS);
        assertEq(aEscrow, 100_000_000, "A escrowed 100 USDC");
        assertEq(aEscrow - 75_000_000, 25_000_000, "A refunded 25 USDC");
    }

    // ---------------------------------------------------------------------
    // Basic shapes
    // ---------------------------------------------------------------------

    function test_undersubscribedFillsAtReserve() public pure {
        // Demand well under supply. Everything fills, and it fills at the
        // RESERVE — not at the lowest tick anyone happened to bid, which would
        // let one dust bid set the price for the whole sale.
        uint256[] memory d = _demand(4);
        d[3] = 10 * ONE;
        d[2] = 5 * ONE;

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, 0, "undersubscribed clears at the reserve");
        assertEq(r.supplySold, 15 * ONE, "only actual demand sells");
        assertEq(ClearingPrice.allocationFor(r, 10 * ONE, 3), 10 * ONE);
        assertEq(ClearingPrice.allocationFor(r, 5 * ONE, 2), 5 * ONE);
    }

    function test_noDemandFailsRatherThanClearingAtZero() public pure {
        uint256[] memory d = _demand(4);
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);
        assertFalse(r.cleared, "an empty book is a failure, not a sale of nothing");
        assertEq(r.supplySold, 0);
        assertEq(ClearingPrice.allocationFor(r, 10 * ONE, 3), 0, "nothing allocates on a failed auction");
    }

    function test_exactlyFullClearsWithoutRationing() public pure {
        uint256[] memory d = _demand(3);
        d[2] = 100 * ONE;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);
        assertEq(r.clearingTick, 2);
        assertEq(ClearingPrice.allocationFor(r, 100 * ONE, 2), 100 * ONE, "exact fill is not rationed");
    }

    function test_singleTickAuction() public pure {
        uint256[] memory d = _demand(1);
        d[0] = 250 * ONE;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, 0);
        assertEq(ClearingPrice.allocationFor(r, 250 * ONE, 0), 100 * ONE, "one bidder takes the lot, rationed");
    }

    // ---------------------------------------------------------------------
    // Pro-rata at the clearing tick
    // ---------------------------------------------------------------------

    function test_identicalBidsAtClearingTickAreTreatedProportionally() public pure {
        // Four identical bids chasing half the supply they want.
        uint256[] memory d = _demand(2);
        d[0] = 200 * ONE; // 4 x 50
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);

        uint256 each = ClearingPrice.allocationFor(r, 50 * ONE, 0);
        assertEq(each, 25 * ONE, "each identical bid gets an identical share");
        assertEq(each * 4, 100 * ONE, "and they exactly exhaust supply");
    }

    function test_proRataIsIndependentOfClaimOrder() public pure {
        // The property that a running "remaining supply" counter would break:
        // whoever claimed last would collect the leftovers.
        uint256[] memory d = _demand(2);
        d[0] = 300 * ONE;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);

        uint256 a1 = ClearingPrice.allocationFor(r, 100 * ONE, 0);
        uint256 b1 = ClearingPrice.allocationFor(r, 200 * ONE, 0);
        // Same calls in the opposite order must give the same answers.
        uint256 b2 = ClearingPrice.allocationFor(r, 200 * ONE, 0);
        uint256 a2 = ClearingPrice.allocationFor(r, 100 * ONE, 0);

        assertEq(a1, a2, "claim order changed an allocation");
        assertEq(b1, b2, "claim order changed an allocation");
        assertEq(a1, 33_333333333333333333, "1/3 of 100, floored");
        assertEq(b1, 66_666666666666666666, "2/3 of 100, floored");
        // Floor rounding leaves dust below supply, never above it.
        assertLe(a1 + b1, 100 * ONE, "allocations exceeded supply");
        assertEq(100 * ONE - (a1 + b1), 1, "1 base unit of dust, to the issuer");
    }

    function test_addingAnIneligibleLowerBidDoesNotChangeTheResult() public pure {
        uint256[] memory d = _demand(4);
        d[3] = 60 * ONE;
        d[2] = 60 * ONE;
        ClearingPrice.Result memory before = ClearingPrice.findClearingTick(d, 100 * ONE);

        // A whale bids below the clearing tick. It must not move the price.
        d[0] = 10_000 * ONE;
        ClearingPrice.Result memory afterBid = ClearingPrice.findClearingTick(d, 100 * ONE);

        assertEq(afterBid.clearingTick, before.clearingTick, "a losing bid moved the clearing price");
        assertEq(afterBid.supplySold, before.supplySold);
        assertEq(
            ClearingPrice.allocationFor(afterBid, 60 * ONE, 2),
            ClearingPrice.allocationFor(before, 60 * ONE, 2),
            "a losing bid changed a winner's allocation"
        );
    }

    // ---------------------------------------------------------------------
    // Guards
    // ---------------------------------------------------------------------

    function test_rejectsZeroSupply() public {
        uint256[] memory d = _demand(2);
        vm.expectRevert("ClearingPrice: zero supply");
        harness.findClearingTick(d, 0);
    }

    function test_rejectsTickCountOutOfBounds() public {
        vm.expectRevert("ClearingPrice: bad tick count");
        harness.findClearingTick(_demand(0), 100);

        vm.expectRevert("ClearingPrice: bad tick count");
        harness.findClearingTick(_demand(ClearingPrice.MAX_TICKS + 1), 100);
    }

    function test_maxTicksIsSupported() public pure {
        // The bound must actually be usable, not just declared.
        uint256[] memory d = _demand(ClearingPrice.MAX_TICKS);
        d[ClearingPrice.MAX_TICKS - 1] = 100 * ONE;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * ONE);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, uint16(ClearingPrice.MAX_TICKS - 1));
    }

    // ---------------------------------------------------------------------
    // Property tests
    // ---------------------------------------------------------------------

    /// Total allocation never exceeds supply, for any demand curve.
    function testFuzz_totalAllocationNeverExceedsSupply(uint96[8] memory raw, uint96 supplyRaw) public pure {
        uint256 supply = uint256(supplyRaw) + 1;
        uint256[] memory d = _demand(8);
        uint256 total;
        for (uint256 i = 0; i < 8; i++) {
            d[i] = uint256(raw[i]);
            total += d[i];
        }
        vm.assume(total > 0);

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        if (!r.cleared) return;

        uint256 allocated;
        for (uint256 i = 0; i < 8; i++) {
            if (d[i] == 0) continue;
            allocated += ClearingPrice.allocationFor(r, d[i], uint16(i));
        }
        assertLe(allocated, supply, "allocated more than the offered supply");
        assertLe(allocated, r.supplySold, "allocated more than the recorded sale");
    }

    /// A bid at or above the clearing tick is never allocated more than it asked
    /// for, and a bid below it is never allocated anything.
    function testFuzz_allocationRespectsBidAndTick(uint96[6] memory raw, uint96 supplyRaw, uint8 tickRaw)
        public
        pure
    {
        uint256 supply = uint256(supplyRaw) + 1;
        uint256[] memory d = _demand(6);
        uint256 total;
        for (uint256 i = 0; i < 6; i++) {
            d[i] = uint256(raw[i]);
            total += d[i];
        }
        vm.assume(total > 0);

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        if (!r.cleared) return;

        uint16 tick = uint16(tickRaw % 6);
        uint256 qty = d[tick];
        if (qty == 0) return;

        uint256 got = ClearingPrice.allocationFor(r, qty, tick);
        assertLe(got, qty, "allocated more than requested");
        if (tick < r.clearingTick) assertEq(got, 0, "a losing bid was allocated tokens");
        if (tick > r.clearingTick) assertEq(got, qty, "a winning bid above the clear was rationed");
    }

    /// The clearing tick is never below the reserve, which is tick 0 by
    /// construction — and the price at it is never below the reserve price.
    function testFuzz_clearingPriceNeverBelowReserve(
        uint96[8] memory raw,
        uint96 supplyRaw,
        uint64 reserve,
        uint64 tickSize
    ) public pure {
        uint256 supply = uint256(supplyRaw) + 1;
        uint256[] memory d = _demand(8);
        uint256 total;
        for (uint256 i = 0; i < 8; i++) {
            d[i] = uint256(raw[i]);
            total += d[i];
        }
        vm.assume(total > 0);

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        if (!r.cleared) return;

        uint256 price = AuctionMath.priceAt(reserve, tickSize, r.clearingTick);
        assertGe(price, reserve, "cleared below the reserve price");
    }

    /// Escrow always covers the settlement charge. This is the invariant that
    /// stops a settlement from taking one bidder's shortfall out of another
    /// bidder's deposit.
    function testFuzz_escrowAlwaysCoversPayment(uint96 qtyRaw, uint64 reserve, uint64 tickSize, uint8 tickRaw)
        public
        pure
    {
        uint256 qty = uint256(qtyRaw);
        uint16 maxTick = uint16(tickRaw);
        vm.assume(qty > 0);

        uint256 escrow = AuctionMath.escrowFor(qty, reserve, tickSize, maxTick, SALE_DECIMALS);

        // Settlement can clear at any tick at or below the bidder's maximum.
        for (uint16 t = 0; t <= maxTick && t < 8; t++) {
            uint256 price = AuctionMath.priceAt(reserve, tickSize, t);
            uint256 paid = AuctionMath.costFloor(qty, price, SALE_DECIMALS);
            assertLe(paid, escrow, "settlement charged more than the bidder escrowed");
        }
    }

    /// Rounding directions: escrow up, charge down. Never the reverse.
    function testFuzz_roundingFavoursTheBidder(uint96 qtyRaw, uint64 price) public pure {
        uint256 qty = uint256(qtyRaw);
        vm.assume(qty > 0 && price > 0);
        uint256 up = AuctionMath.costCeil(qty, price, SALE_DECIMALS);
        uint256 down = AuctionMath.costFloor(qty, price, SALE_DECIMALS);
        assertGe(up, down, "ceil rounded below floor");
        assertLe(up - down, 1, "rounding gap wider than one base unit");
    }

    /// Fees never exceed the configured basis points, and never apply to zero.
    function testFuzz_feeNeverExceedsConfigured(uint128 proceeds, uint16 bpsRaw) public pure {
        uint16 bps = uint16(bpsRaw % 10_001);
        uint256 fee = AuctionMath.feeOn(proceeds, bps);
        assertLe(fee, proceeds, "fee exceeded the proceeds");
        // floor(p * bps / 10000) <= p * bps / 10000
        assertLe(fee * 10_000, uint256(proceeds) * bps, "fee rounded up against the issuer");
    }

    /// Settlement cannot create sale tokens: sold + unsold == offered supply.
    function testFuzz_settlementConservesSupply(uint96[8] memory raw, uint96 supplyRaw) public pure {
        uint256 supply = uint256(supplyRaw) + 1;
        uint256[] memory d = _demand(8);
        uint256 total;
        for (uint256 i = 0; i < 8; i++) {
            d[i] = uint256(raw[i]);
            total += d[i];
        }
        vm.assume(total > 0);

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        uint256 sold = r.cleared ? r.supplySold : 0;
        assertLe(sold, supply, "sold more than was offered");
        uint256 unsold = supply - sold;
        assertEq(sold + unsold, supply, "supply was not conserved");
    }
}

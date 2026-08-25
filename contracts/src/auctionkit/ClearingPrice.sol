// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @title ClearingPrice
/// @notice The uniform-price sealed-bid auction algorithm, as a pure library.
///
/// This is deliberately the first thing built and the only thing in AuctionKit
/// with no storage, no tokens, no access control and no external calls. The
/// clearing rule is the part of this product that is hard to get right and easy
/// to get wrong *silently* — an off-by-one in a rounding direction does not
/// revert, it quietly mis-allocates someone's money. Isolating it means it can
/// be fuzzed and property-tested on its own before anything holds funds.
///
/// ## The mechanism
///
/// Demand is bucketed by the maximum price tick each bidder was willing to pay.
/// Scanning from the highest tick down toward the reserve, the clearing tick is
/// the first tick at which cumulative demand reaches or exceeds the offered
/// supply. Everyone who wins pays that one price — including bidders who were
/// willing to pay far more.
///
/// That last property is the point of a uniform-price auction: bidding your
/// true maximum cannot cost you more than the clearing price, so there is no
/// incentive to shade your bid downward and guess at what others will do.
///
/// ## Bounded by construction
///
/// The scan is over ticks, not over bids. `numTicks` is bounded by
/// `MAX_TICKS = 256`, so settlement cost is bounded by auction configuration and
/// cannot be inflated by an attacker submitting many bids or extreme prices.
/// Nothing here sorts a bidder-controlled array.
library ClearingPrice {
    /// @notice Hard ceiling on price ticks. Bounds the settlement scan.
    /// @dev 256 ticks at a sensible tick size covers any realistic price range;
    ///      raising it raises worst-case settlement gas linearly.
    uint256 internal constant MAX_TICKS = 256;

    /// @notice Outcome of the clearing scan.
    /// @param cleared        false when demand never reached the reserve tick
    /// @param clearingTick   the tick everyone pays at
    /// @param supplySold     total sale-token base units allocated
    /// @param demandAtClearingTick   demand sitting exactly at the clearing tick
    /// @param supplyForClearingTick  supply left for that tick after the strictly
    ///                               higher ticks were filled in full
    struct Result {
        bool cleared;
        uint16 clearingTick;
        uint256 supplySold;
        uint256 demandAtClearingTick;
        uint256 supplyForClearingTick;
    }

    /// @notice Find the clearing tick from bucketed demand.
    ///
    /// @param demandByTick  demand in sale-token base units, indexed by tick.
    ///                      Index 0 is the reserve price. Length must be the
    ///                      auction's `numTicks`.
    /// @param supply        offered supply in sale-token base units.
    ///
    /// @dev Two outcomes that are easy to conflate and must not be:
    ///
    ///      - **Oversubscribed**: cumulative demand crosses supply at some tick.
    ///        That tick clears; bids above it fill fully, bids at it pro-rata.
    ///
    ///      - **Undersubscribed**: total demand never reaches supply. Everything
    ///        eligible fills, at the *reserve* — not at the lowest tick anyone
    ///        happened to bid. Charging the lowest observed bid would let a
    ///        single dust bid at the reserve set the price for the whole sale.
    ///
    ///      `cleared == false` means no demand at all; the auction fails and
    ///      everything is refundable.
    function findClearingTick(uint256[] memory demandByTick, uint256 supply)
        internal
        pure
        returns (Result memory result)
    {
        uint256 numTicks = demandByTick.length;
        require(numTicks > 0 && numTicks <= MAX_TICKS, "ClearingPrice: bad tick count");
        require(supply > 0, "ClearingPrice: zero supply");

        uint256 cumulative = 0;

        // Scan high to low. `i` counts down through ticks; tick 0 is the reserve.
        for (uint256 i = numTicks; i > 0; --i) {
            uint256 tick = i - 1;
            uint256 demandHere = demandByTick[tick];
            uint256 cumulativeBefore = cumulative;
            cumulative += demandHere;

            if (cumulative >= supply) {
                // This tick clears. Bids strictly above it took
                // `cumulativeBefore`; the rest of the supply is shared here.
                result.cleared = true;
                // Safe: `tick < numTicks <= MAX_TICKS (256)`, enforced by the
                // require at the top of this function, so it always fits uint16.
                // forge-lint: disable-next-line(unsafe-typecast)
                result.clearingTick = uint16(tick);
                result.supplySold = supply;
                result.demandAtClearingTick = demandHere;
                result.supplyForClearingTick = supply - cumulativeBefore;
                return result;
            }
        }

        // Undersubscribed: everything eligible fills, at the reserve.
        if (cumulative == 0) {
            // No demand at all. Not "cleared at zero" — the auction failed, and
            // the caller must route to refunds rather than settle a sale of
            // nothing at the reserve price.
            result.cleared = false;
            return result;
        }

        result.cleared = true;
        result.clearingTick = 0;
        result.supplySold = cumulative;
        result.demandAtClearingTick = demandByTick[0];
        // Everyone at the reserve fills in full, so pro-rata is a no-op here.
        result.supplyForClearingTick = demandByTick[0];
        return result;
    }

    /// @notice Allocation for one bid, given a finalized clearing result.
    ///
    /// @dev Order-independent by construction. The pro-rata share is computed
    ///      from the bid's own quantity and two totals that were fixed at
    ///      finalization — never from a running counter — so the result does not
    ///      depend on which bidder claims first, or whether anyone claims at all.
    ///
    ///      A running "remaining supply" counter would be the natural
    ///      implementation and would be wrong: the last claimer would get
    ///      whatever was left, making allocation a race.
    ///
    ///      Rounding is `Floor`, so the sum of allocations can be a few base
    ///      units below `supplyForClearingTick`. That dust is deterministic,
    ///      claim-order independent, and returns to the issuer as unsold supply.
    function allocationFor(Result memory result, uint256 bidQuantity, uint16 bidTick)
        internal
        pure
        returns (uint256)
    {
        if (!result.cleared) return 0;
        // Below the clearing price: no allocation, full refund.
        if (bidTick < result.clearingTick) return 0;
        // Above it: filled in full.
        if (bidTick > result.clearingTick) return bidQuantity;

        // Exactly at the clearing tick.
        if (result.demandAtClearingTick <= result.supplyForClearingTick) {
            // Enough to go round; no rationing needed.
            return bidQuantity;
        }
        return Math.mulDiv(bidQuantity, result.supplyForClearingTick, result.demandAtClearingTick);
    }
}

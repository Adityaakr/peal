// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @title AuctionMath
/// @notice Decimal-safe price and cost arithmetic.
///
/// ## Price representation
///
/// A price is **quote-token base units per one whole sale token**:
///
///     price(tick) = reservePrice + tick * tickSize
///     cost        = quantity * price / 10**saleDecimals
///
/// So for an 18-decimal sale token priced in 6-decimal USDC, a price of
/// `1_500_000` means 1.50 USDC per whole token. `quantity` is always in sale
/// base units, never whole tokens, because whole-token quantities cannot express
/// a partial allocation.
///
/// Using OZ `Math.mulDiv` rather than `a * b / c` is not stylistic: the
/// intermediate `quantity * price` overflows 256 bits for entirely ordinary
/// inputs (a 1e24 base-unit quantity times a 1e30 price), and `mulDiv` carries
/// the full 512-bit intermediate.
///
/// ## Rounding direction is a security property
///
/// Every rounding choice here is made in the direction that cannot leave the
/// contract short:
///
///   - **Escrow rounds up.** A bidder's deposit must cover their worst case. A
///     deposit one base unit short is a settlement that reverts, or worse, one
///     that succeeds by taking the shortfall from another bidder's escrow.
///   - **Settlement charges round down.** The protocol never over-charges.
///
/// The gap between the two is dust in the *bidder's* favour, refundable to them.
/// Both directions are asserted by tests, including a fuzz test that the escrow
/// for a bid is never less than the amount settlement will charge it.
library AuctionMath {
    /// @notice Price at a tick, in quote base units per whole sale token.
    /// @dev Ticks are validated against `numTicks` by the caller; this is pure
    ///      arithmetic and will happily price a tick that does not exist.
    function priceAt(uint256 reservePrice, uint256 tickSize, uint16 tick) internal pure returns (uint256) {
        return reservePrice + uint256(tick) * tickSize;
    }

    /// @notice Quote cost of `quantity` sale base units at `price`, rounded down.
    /// @dev Used for what a bidder actually pays at settlement.
    function costFloor(uint256 quantity, uint256 price, uint8 saleDecimals) internal pure returns (uint256) {
        return Math.mulDiv(quantity, price, 10 ** saleDecimals, Math.Rounding.Floor);
    }

    /// @notice Quote cost rounded up.
    /// @dev Used for escrow, so the deposit always covers the maximum payment.
    function costCeil(uint256 quantity, uint256 price, uint8 saleDecimals) internal pure returns (uint256) {
        return Math.mulDiv(quantity, price, 10 ** saleDecimals, Math.Rounding.Ceil);
    }

    /// @notice Escrow required for a bid: quantity at the bidder's maximum price.
    function escrowFor(uint256 quantity, uint256 reservePrice, uint256 tickSize, uint16 maxTick, uint8 saleDecimals)
        internal
        pure
        returns (uint256)
    {
        return costCeil(quantity, priceAt(reservePrice, tickSize, maxTick), saleDecimals);
    }

    /// @notice Protocol fee on settled proceeds.
    /// @dev Floor, so the fee never rounds up against the issuer, and only ever
    ///      applied to proceeds that actually settled — never to refunds.
    function feeOn(uint256 proceeds, uint16 feeBps) internal pure returns (uint256) {
        return Math.mulDiv(proceeds, feeBps, 10_000, Math.Rounding.Floor);
    }
}

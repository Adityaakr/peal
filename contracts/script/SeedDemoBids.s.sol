// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {AuctionMath} from "../src/auctionkit/AuctionMath.sol";

/// @notice Place real sealed bids on a demo auction so the interface has
///         something true to render.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  funds the bidders; also the demo token owner
///   AUCTION               the auction to bid into
///
/// These are genuine bids from genuine accounts: escrow really moves, the
/// commitments are real, and nothing about their contents is recoverable from
/// chain until the auction closes. The alternative — seeding the UI with
/// invented rows — would make the one thing this product demonstrates a lie.
///
/// The bidder keys are `keccak256("peal-demo-bidder-<i>")`, derivable by anyone,
/// so the salts below are reproducible and the reveal can be reconstructed
/// without trusting whoever ran this. Testnet only.
contract SeedDemoBids is Script {
    struct Spec {
        uint256 quantity;
        uint16 tick;
    }

    function bidderKey(uint256 i) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("peal-demo-bidder-", i)));
    }

    /// Salt is derived, not random, so this run is reproducible.
    function saltFor(uint256 i) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("peal-demo-salt-", i));
    }

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        SealedBidAuction a = SealedBidAuction(vm.envAddress("AUCTION"));
        SealedBidAuction.Config memory cfg = a.getConfig();
        DemoToken quote = DemoToken(cfg.quoteToken);

        // A book that actually clears: 300 + 250 + 400 = 950 against 1,000,000
        // supply is undersubscribed, so spread the ticks to make the ladder
        // legible rather than a single spike.
        Spec[4] memory specs = [
            Spec(120_000 ether, 18), // well above
            Spec(300_000 ether, 12),
            Spec(450_000 ether, 7), //  around where it will clear
            Spec(260_000 ether, 2) //  low
        ];

        for (uint256 i = 0; i < specs.length; ++i) {
            uint256 pk = bidderKey(i);
            address bidder = vm.addr(pk);
            uint256 escrow = AuctionMath.escrowFor(
                specs[i].quantity, cfg.reservePrice, cfg.tickSize, specs[i].tick, cfg.saleDecimals
            );

            // Fund from the deployer: demo money plus enough gas to bid.
            vm.startBroadcast(deployerPk);
            quote.mint(bidder, escrow);
            if (bidder.balance < 0.01 ether) payable(bidder).transfer(0.02 ether);
            vm.stopBroadcast();

            bytes32 commitment =
                a.bidCommitment(bidder, specs[i].quantity, specs[i].tick, saltFor(i), 1);

            vm.startBroadcast(pk);
            quote.approve(address(a), escrow);
            uint32 bidId = a.commitBid(
                commitment, keccak256(abi.encodePacked("peal-demo-ct-", i)), escrow, new bytes32[](0)
            );
            vm.stopBroadcast();

            console2.log("bid", bidId);
            console2.log("  bidder ", bidder);
            console2.log("  qty    ", specs[i].quantity);
            console2.log("  tick   ", specs[i].tick);
            console2.log("  escrow ", escrow);
        }

        console2.log("committedBidCount", a.committedBidCount());
    }
}

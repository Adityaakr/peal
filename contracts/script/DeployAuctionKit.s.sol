// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CommitteeRegistry} from "../src/auctionkit/CommitteeRegistry.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";

/// @notice Deploy the reusable half of AuctionKit: the committee registry and
///         the auction implementation that every auction clones.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts
///
/// Deliberately deploys **no committee set and no auction**. Both are decisions
/// rather than deployments:
///
///   - A committee set is content-addressed and has no update path, so
///     registering one commits to those signers forever for any auction that
///     snapshots it. Registering placeholders "to have something there" would
///     produce a set that can never actually sign a reveal, and auctions using
///     it would run to `failOnRevealTimeout` and refund. See
///     docs/auctionkit/decisions/0001-reveal-root.md.
///   - An auction escrows real supply on `initialize`, so it needs a real
///     issuer, a real token and real parameters.
///
/// Both pieces here are permanent, parameterless and hold no funds, which is
/// what makes them safe to deploy before those decisions are made. Registering
/// a set is permissionless afterwards and needs no redeploy.
contract DeployAuctionKit is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("chainid ", block.chainid);
        console2.log("deployer", deployer);
        console2.log("balance ", deployer.balance);

        vm.startBroadcast(pk);

        CommitteeRegistry registry = new CommitteeRegistry();

        // The clone template. Its constructor calls `_disableInitializers()`,
        // so this instance is permanently uninitialised and can never itself
        // hold an auction or any funds - only clones of it can.
        SealedBidAuction implementation = new SealedBidAuction();

        vm.stopBroadcast();

        console2.log("CommitteeRegistry  ", address(registry));
        console2.log("SealedBidAuction   ", address(implementation));

        // Machine-readable, so the services and the runbook can consume it
        // without anyone transcribing an address by hand.
        console2.log(
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"committeeRegistry":"',
                vm.toString(address(registry)),
                '","auctionImplementation":"',
                vm.toString(address(implementation)),
                '"}'
            )
        );
    }
}

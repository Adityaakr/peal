// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionFactory} from "../src/auctionkit/AuctionFactory.sol";
import {CommitteeRegistry} from "../src/auctionkit/CommitteeRegistry.sol";

/// @notice Deploy the factory that lets anyone create an auction.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY    broadcasts
///   AUCTION_IMPLEMENTATION  the clone template
///   COMMITTEE_REGISTRY      the registry auctions snapshot from
///
/// Prints the deployment block, which clients need: reading AuctionCreated
/// from that block rather than from zero is the difference between a listing
/// that loads and one that times out on a chain a few million blocks deep.
contract DeployFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address impl = vm.envAddress("AUCTION_IMPLEMENTATION");
        CommitteeRegistry registry = CommitteeRegistry(vm.envAddress("COMMITTEE_REGISTRY"));

        vm.startBroadcast(pk);
        AuctionFactory factory = new AuctionFactory(impl, registry);
        vm.stopBroadcast();

        console2.log("factory      ", address(factory));
        console2.log("deployedBlock", block.number);
        console2.log(
            string.concat(
                '{"factory":"', vm.toString(address(factory)),
                '","deployedBlock":', vm.toString(block.number), '}'
            )
        );
    }
}

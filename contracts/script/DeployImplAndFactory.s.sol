// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionFactory} from "../src/auctionkit/AuctionFactory.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../src/auctionkit/CommitteeRegistry.sol";

/// @notice Redeploy the implementation and a factory pointing at it.
///
/// The two must move together. A factory clones one fixed implementation
/// address, so a factory paired with an older implementation silently creates
/// auctions running code the repository no longer has. The registry is
/// unchanged and keeps its committee sets.
contract DeployImplAndFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        CommitteeRegistry registry = CommitteeRegistry(vm.envAddress("COMMITTEE_REGISTRY"));

        vm.startBroadcast(pk);
        SealedBidAuction impl = new SealedBidAuction();
        AuctionFactory factory = new AuctionFactory(address(impl), registry);
        vm.stopBroadcast();

        console2.log("implementation", address(impl));
        console2.log("factory       ", address(factory));
        console2.log("deployedBlock ", block.number);
    }
}

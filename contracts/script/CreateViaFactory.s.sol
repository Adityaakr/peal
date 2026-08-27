// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionFactory} from "../src/auctionkit/AuctionFactory.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";
import {DemoToken} from "../src/DemoToken.sol";

/// @notice Create an auction the way the UI does, to prove the path end to end.
contract CreateViaFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address issuer = vm.addr(pk);
        AuctionFactory factory = AuctionFactory(vm.envAddress("FACTORY"));
        DemoToken sale = DemoToken(vm.envAddress("SALE_TOKEN"));

        string memory name = "Genesis community round";
        string memory useCase = "token-launch";
        string memory details = "500,000 PEALD, sealed bids, uniform clearing price";

        uint64 start = uint64(block.timestamp);
        uint256 supply = 500_000 ether;

        SealedBidAuction.Config memory cfg = SealedBidAuction.Config({
            issuer: issuer,
            saleToken: address(sale),
            quoteToken: vm.envAddress("QUOTE_TOKEN"),
            totalSupply: supply,
            saleDecimals: 18,
            quoteDecimals: 18,
            reservePrice: 1 ether,
            tickSize: 0.1 ether,
            numTicks: 32,
            startTime: start,
            endTime: start + 6 hours,
            revealDeadline: start + 6 hours + 4 hours,
            minBidQuantity: 1 ether,
            maxQuantityPerAddress: 0,
            maxBids: 256,
            allowlistRoot: bytes32(0),
            protocolFeeBps: 0,
            feeRecipient: issuer,
            committeeSetId: vm.envBytes32("COMMITTEE_SET_ID"),
            encryptionEpoch: keccak256("factory-demo-1"),
            metadataHash: factory.metadataHash(name, useCase, details),
            version: 1
        });

        vm.startBroadcast(pk);
        sale.mint(issuer, supply);
        sale.approve(address(factory), supply);
        address auction = factory.createAuction(cfg, name, useCase, details);
        vm.stopBroadcast();

        console2.log("auction ", auction);
        console2.log("count   ", factory.auctionCount());
        console2.log("state   ", uint256(SealedBidAuction(auction).state()));
    }
}

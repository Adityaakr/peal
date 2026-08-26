// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CommitteeRegistry} from "../src/auctionkit/CommitteeRegistry.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";
import {DemoToken} from "../src/DemoToken.sol";

/// @notice Stand up one live sealed-bid auction on a testnet, end to end.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   broadcasts; also the issuer and fee recipient
///   COMMITTEE_REGISTRY     from DeployAuctionKit
///   AUCTION_IMPLEMENTATION from DeployAuctionKit
///   BID_WINDOW_SECS        optional, default 3600
///   REVEAL_WINDOW_SECS     optional, default 3600 (after bidding closes)
///
/// ## The committee here is a prop, and deliberately a legible one
///
/// Its five signing keys are `keccak256("peal-demo-committee-<i>")`, so anyone
/// reading this file can derive them, sign a reveal root, and drive the auction
/// themselves. That is the point on a testnet: the demo is reproducible and
/// nobody is misled about custody.
///
/// It is a prop because `bte-node` has no ECDSA key. The nodes hold BLS
/// threshold shares; `CommitteeRegistry` wants EVM addresses that sign reveal
/// roots, and nothing in the running node software produces one yet. Until that
/// lands, a "real" committee here would be equally fake but less honest about
/// it. See docs/auctionkit/decisions/0001-reveal-root.md.
///
/// **Never run this against a chain with real funds.**
contract DeployDemoAuction is Script {
    uint16 constant THRESHOLD = 3;
    uint256 constant COMMITTEE_SIZE = 5;

    uint256 constant SALE_SUPPLY = 1_000_000 ether; // tokens for sale
    uint256 constant QUOTE_MINT = 10_000_000 ether; // demo USDC per bidder faucet

    // 1.00 quote per whole sale token, stepping 0.10 across 32 ticks -> 1.00..4.10
    uint256 constant RESERVE_PRICE = 1 ether;
    uint256 constant TICK_SIZE = 0.1 ether;
    uint16 constant NUM_TICKS = 32;

    function committeeKey(uint256 i) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("peal-demo-committee-", i)));
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address issuer = vm.addr(pk);
        CommitteeRegistry registry = CommitteeRegistry(vm.envAddress("COMMITTEE_REGISTRY"));
        address impl = vm.envAddress("AUCTION_IMPLEMENTATION");

        uint64 bidWindow = uint64(vm.envOr("BID_WINDOW_SECS", uint256(3600)));
        uint64 revealWindow = uint64(vm.envOr("REVEAL_WINDOW_SECS", uint256(3600)));

        address[] memory members = new address[](COMMITTEE_SIZE);
        for (uint256 i = 0; i < COMMITTEE_SIZE; ++i) {
            members[i] = vm.addr(committeeKey(i));
        }

        vm.startBroadcast(pk);

        bytes32 setId = registry.registerCommitteeSet(THRESHOLD, members);

        DemoToken sale = new DemoToken("Peal Demo Sale", "PEALD", issuer);
        DemoToken quote = new DemoToken("Peal Demo USD", "DUSD", issuer);
        sale.mint(issuer, SALE_SUPPLY);
        quote.mint(issuer, QUOTE_MINT);

        SealedBidAuction auction = SealedBidAuction(Clones.clone(impl));

        // startTime is now: `openCommit` is permissionless but refuses before
        // it, and a demo that opens an hour from now is not a demo.
        uint64 start = uint64(block.timestamp);
        SealedBidAuction.Config memory cfg = SealedBidAuction.Config({
            issuer: issuer,
            saleToken: address(sale),
            quoteToken: address(quote),
            totalSupply: SALE_SUPPLY,
            saleDecimals: 18,
            quoteDecimals: 18,
            reservePrice: RESERVE_PRICE,
            tickSize: TICK_SIZE,
            numTicks: NUM_TICKS,
            startTime: start,
            endTime: start + bidWindow,
            revealDeadline: start + bidWindow + revealWindow,
            minBidQuantity: 1 ether,
            maxQuantityPerAddress: SALE_SUPPLY / 5,
            maxBids: 256,
            allowlistRoot: bytes32(0), // open auction
            protocolFeeBps: 100, // 1%
            feeRecipient: issuer,
            committeeSetId: setId,
            encryptionEpoch: keccak256("peal-demo-epoch-1"),
            metadataHash: keccak256("peal-demo-auction-1"),
            version: 1
        });
        auction.initialize(cfg, address(registry));

        // Escrow the supply before bidding can open. A bidder must never be
        // able to commit funds to an auction whose tokens are not already
        // locked.
        sale.approve(address(auction), SALE_SUPPLY);
        auction.fund();
        auction.openCommit();

        vm.stopBroadcast();

        console2.log("committeeSetId");
        console2.logBytes32(setId);
        console2.log("saleToken      ", address(sale));
        console2.log("quoteToken     ", address(quote));
        console2.log("auction        ", address(auction));
        console2.log("state (2=CommitOpen)", uint256(auction.state()));
        console2.log("bidding closes ", cfg.endTime);
        console2.log("reveal deadline", cfg.revealDeadline);

        console2.log(
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"auction":"',
                vm.toString(address(auction)),
                '","saleToken":"',
                vm.toString(address(sale)),
                '","quoteToken":"',
                vm.toString(address(quote)),
                '","committeeSetId":"',
                vm.toString(setId),
                '","endTime":',
                vm.toString(cfg.endTime),
                ',"revealDeadline":',
                vm.toString(cfg.revealDeadline),
                "}"
            )
        );
    }
}

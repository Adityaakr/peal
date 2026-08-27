// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {AuctionFactory} from "../../src/auctionkit/AuctionFactory.sol";
import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../../src/auctionkit/CommitteeRegistry.sol";

contract TT is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 v) external { _mint(to, v); }
}

contract AuctionFactoryTest is Test {
    AuctionFactory factory;
    CommitteeRegistry registry;
    TT sale;
    TT quote;
    bytes32 setId;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SUPPLY = 1000e18;

    function setUp() public {
        registry = new CommitteeRegistry();
        address[] memory m = new address[](5);
        for (uint256 i = 0; i < 5; i++) m[i] = vm.addr(uint256(keccak256(abi.encodePacked("k", i))));
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) if (m[j] < m[i]) (m[i], m[j]) = (m[j], m[i]);
        }
        setId = registry.registerCommitteeSet(3, m);
        factory = new AuctionFactory(address(new SealedBidAuction()), registry);
        sale = new TT("SALE");
        quote = new TT("QUOTE");
    }

    function _cfg(address issuer, bytes32 mh) internal view returns (SealedBidAuction.Config memory) {
        uint64 start = uint64(block.timestamp);
        return SealedBidAuction.Config({
            issuer: issuer,
            saleToken: address(sale),
            quoteToken: address(quote),
            totalSupply: SUPPLY,
            saleDecimals: 18,
            quoteDecimals: 18,
            reservePrice: 1e18,
            tickSize: 1e17,
            numTicks: 32,
            startTime: start,
            endTime: start + 3600,
            revealDeadline: start + 3600 + 4 hours,
            minBidQuantity: 1e18,
            maxQuantityPerAddress: 0,
            maxBids: 256,
            allowlistRoot: bytes32(0),
            protocolFeeBps: 0,
            feeRecipient: issuer,
            committeeSetId: setId,
            encryptionEpoch: keccak256("e"),
            metadataHash: mh,
            version: 1
        });
    }

    function _create(address who, string memory name, string memory useCase, string memory details)
        internal
        returns (address)
    {
        sale.mint(who, SUPPLY);
        bytes32 mh = factory.metadataHash(name, useCase, details);
        vm.startPrank(who);
        sale.approve(address(factory), SUPPLY);
        address a = factory.createAuction(_cfg(who, mh), name, useCase, details);
        vm.stopPrank();
        return a;
    }

    /// The whole point: someone who is not the deployer can create an auction.
    function test_anyoneCanCreateAnAuction() public {
        address a = _create(alice, "Alice DAO sale", "dao-treasury", "block sale of 1000 tokens");
        assertTrue(factory.isAuction(a));
        assertEq(factory.auctionCount(), 1);
        assertEq(SealedBidAuction(a).getConfig().issuer, alice);
    }

    /// An auction must never exist unfunded. A bidder finding a live-looking
    /// auction with no supply would be committing escrow against nothing.
    function test_auctionIsFundedAndOpenInOneTransaction() public {
        address a = _create(alice, "n", "token-launch", "d");
        assertEq(sale.balanceOf(a), SUPPLY, "supply must already be escrowed");
        assertEq(uint256(SealedBidAuction(a).state()), uint256(SealedBidAuction.State.CommitOpen));
    }

    /// Nobody can mint an auction attributed to a project they do not control.
    function test_cannotCreateAnAuctionForSomeoneElse() public {
        sale.mint(bob, SUPPLY);
        bytes32 mh = factory.metadataHash("n", "u", "d");
        vm.startPrank(bob);
        sale.approve(address(factory), SUPPLY);
        vm.expectRevert("issuer");
        factory.createAuction(_cfg(alice, mh), "n", "u", "d");
        vm.stopPrank();
    }

    /// The label shown beside an auction is bound to what its issuer committed.
    function test_metadataIsBoundToTheAuction() public {
        sale.mint(alice, SUPPLY);
        bytes32 wrong = factory.metadataHash("real name", "u", "d");
        vm.startPrank(alice);
        sale.approve(address(factory), SUPPLY);
        vm.expectRevert("metadata");
        factory.createAuction(_cfg(alice, wrong), "a different name", "u", "d");
        vm.stopPrank();
    }

    /// The event is the registry, so it has to carry enough to render a list.
    function test_creationEventCarriesTheListing() public {
        sale.mint(alice, SUPPLY);
        bytes32 mh = factory.metadataHash("Tournament A", "tournament", "prize pool sale");
        vm.startPrank(alice);
        sale.approve(address(factory), SUPPLY);
        vm.recordLogs();
        factory.createAuction(_cfg(alice, mh), "Tournament A", "tournament", "prize pool sale");
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256(
                "AuctionCreated(address,address,address,address,uint256,uint64,uint64,string,string,string)"
            )) {
                (,,,, string memory name, string memory useCase,) =
                    abi.decode(logs[i].data, (address, uint256, uint64, uint64, string, string, string));
                assertEq(name, "Tournament A");
                assertEq(useCase, "tournament");
                found = true;
            }
        }
        assertTrue(found, "AuctionCreated must be emitted");
    }

    function test_pagingIsBoundedAndDoesNotRevertPastTheEnd() public {
        for (uint256 i = 0; i < 3; i++) _create(alice, "n", "u", "d");
        assertEq(factory.auctionsPaged(0, 2).length, 2);
        assertEq(factory.auctionsPaged(2, 50).length, 1, "limit past the end clamps");
        assertEq(factory.auctionsPaged(99, 10).length, 0, "offset past the end is empty, not a revert");
    }

    function test_auctionsAreListedPerIssuer() public {
        _create(alice, "a", "u", "d");
        _create(bob, "b", "u", "d");
        _create(alice, "c", "u", "d");
        assertEq(factory.auctionsOf(alice).length, 2);
        assertEq(factory.auctionsOf(bob).length, 1);
    }

    /// The factory is a deployer, not a vault. Nothing should accumulate in it.
    function test_factoryKeepsNothing() public {
        _create(alice, "n", "u", "d");
        assertEq(sale.balanceOf(address(factory)), 0);
        assertEq(quote.balanceOf(address(factory)), 0);
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../../src/auctionkit/CommitteeRegistry.sol";
import {AuctionMath} from "../../src/auctionkit/AuctionMath.sol";

contract TestToken is ERC20 {
    constructor() ERC20("t", "t") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/// @notice `bidCommitment` binds `bidId`, but a bidder only learns their `bidId`
///         after `commitBid` returns. Both consequences of that are proved here.
///
/// These tests PASS, and that is the bad news: they assert the behaviour the
/// contract has today, which is broken. They exist to pin the vulnerability so
/// a fix has something to flip, and so it cannot regress silently afterwards.
///
/// When the fix lands, both tests must be rewritten to assert the corrected
/// behaviour - do not simply delete them.
contract BidIdRaceTest is Test {
    SealedBidAuction impl;
    CommitteeRegistry registry;
    TestToken sale;
    TestToken quote;

    uint256[5] keys;
    address[] committee;
    bytes32 setId;

    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address griefer = makeAddr("griefer");

    uint256 constant SUPPLY = 1000e18;
    uint256 constant RESERVE = 1e6;
    uint256 constant TICK = 5e5;
    uint16 constant NUM_TICKS = 8;
    uint8 constant SALE_DEC = 18;

    uint64 startTime;
    uint64 endTime;
    uint64 revealDeadline;

    function setUp() public {
        impl = new SealedBidAuction();
        registry = new CommitteeRegistry();
        sale = new TestToken();
        quote = new TestToken();

        address[] memory m = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            keys[i] = uint256(keccak256(abi.encodePacked("k", i)));
            m[i] = vm.addr(keys[i]);
        }
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) {
                if (m[j] < m[i]) {
                    (m[i], m[j]) = (m[j], m[i]);
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
        committee = m;
        setId = registry.registerCommitteeSet(3, m);

        startTime = uint64(block.timestamp + 100);
        endTime = startTime + 1000;
        revealDeadline = endTime + 1000;
    }

    function _open() internal returns (SealedBidAuction a) {
        a = SealedBidAuction(Clones.clone(address(impl)));
        a.initialize(
            SealedBidAuction.Config({
                issuer: issuer,
                saleToken: address(sale),
                quoteToken: address(quote),
                totalSupply: SUPPLY,
                saleDecimals: SALE_DEC,
                quoteDecimals: 6,
                reservePrice: RESERVE,
                tickSize: TICK,
                numTicks: NUM_TICKS,
                startTime: startTime,
                endTime: endTime,
                revealDeadline: revealDeadline,
                minBidQuantity: 1e15,
                maxQuantityPerAddress: 0,
                maxBids: 100,
                allowlistRoot: bytes32(0),
                protocolFeeBps: 0,
                feeRecipient: issuer,
                committeeSetId: setId,
                encryptionEpoch: keccak256("e"),
                metadataHash: keccak256("m"),
                version: 1
            }),
            address(registry)
        );
        sale.mint(issuer, SUPPLY);
        vm.startPrank(issuer);
        sale.approve(address(a), SUPPLY);
        a.fund();
        vm.stopPrank();
        vm.warp(startTime);
        a.openCommit();
    }

    function _commitWithPredictedId(SealedBidAuction a, address who, uint256 qty, uint16 tick, uint32 predictedId)
        internal
        returns (uint32 actualId)
    {
        uint256 escrow = AuctionMath.escrowFor(qty, RESERVE, TICK, tick, SALE_DEC);
        quote.mint(who, escrow);
        bytes32 c = a.bidCommitment(predictedId, who, qty, tick, keccak256("salt"), 1);
        vm.startPrank(who);
        quote.approve(address(a), escrow);
        actualId = a.commitBid(c, keccak256(abi.encode("ct", who)), escrow, new bytes32[](0));
        vm.stopPrank();
    }

    function _signRoot(SealedBidAuction a, bytes32 root, uint32 count) internal view returns (bytes[] memory sigs) {
        bytes32 digest = a.revealRootDigest(root, count);
        sigs = new bytes[](3);
        for (uint256 i = 0; i < 3; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    function _hashPair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encode(x, y)) : keccak256(abi.encode(y, x));
    }

    /// TWO bidders who both read `committedBidCount()` as 0 before either lands.
    /// This is not exotic - it is what two wallets in the same block do.
    function test_concurrentBiddersLoseTheRace() public {
        SealedBidAuction a = _open();

        // Both read committedBidCount() == 0 and build a commitment for id 0.
        uint32 aliceId = _commitWithPredictedId(a, alice, 10e18, 3, 0);
        uint32 bobId = _commitWithPredictedId(a, bob, 10e18, 3, 0);

        assertEq(aliceId, 0);
        assertEq(bobId, 1, "bob landed at 1, but committed to 0");

        // Bob's posted commitment is for bidId 0; his actual bid is id 1.
        SealedBidAuction.Bid memory stored = a.getBid(1);
        bytes32 whatBobNeedsAtReveal = a.bidCommitment(1, bob, 10e18, 3, keccak256("salt"), 1);
        assertTrue(stored.commitment != whatBobNeedsAtReveal, "bob's commitment should be unusable");
    }

    /// The consequence: one unrevealable bid halts the whole auction. Every
    /// honest bidder is refunded, and the issuer sells nothing.
    ///
    /// A griefer needs one bid with a junk commitment and 1 wei of escrow.
    /// `commitBid` cannot check a commitment - that is the point of a sealed
    /// bid - so there is nothing to reject at commit time.
    function test_oneJunkCommitmentBricksTheEntireAuction() public {
        SealedBidAuction a = _open();

        _commitWithPredictedId(a, alice, 10e18, 3, 0);

        // The griefer posts a commitment to nothing at all.
        quote.mint(griefer, 1);
        vm.startPrank(griefer);
        quote.approve(address(a), 1);
        a.commitBid(keccak256("junk"), keccak256("ct-junk"), 1, new bytes32[](0));
        vm.stopPrank();

        vm.warp(endTime);
        a.closeCommit();

        // The committee honestly reveals what it can: alice's bid. It cannot
        // produce a preimage for the griefer's commitment, because none exists.
        bytes32 leafA = a.revealLeaf(0, 10e18, 3, keccak256("salt"));
        bytes32 root = _hashPair(leafA, leafA);
        a.registerRevealRoot(root, 2, _signRoot(a, root, 2));

        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](1);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafA;
        entries[0] = SealedBidAuction.RevealEntry({
            bidId: 0,
            quantity: 10e18,
            tick: 3,
            salt: keccak256("salt"),
            bidVersion: 1,
            proof: proof
        });
        a.processReveals(entries);

        // One bid short, forever. finalize() can never succeed.
        vm.expectRevert();
        a.finalize();

        // The auction dies on the timeout path. Funds are safe - this is
        // denial of service, not theft - but nothing is ever sold.
        vm.warp(revealDeadline);
        a.failOnRevealTimeout();
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Failed));
    }
}

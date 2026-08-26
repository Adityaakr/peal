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

/// @notice Regression tests for two linked defects that are now fixed.
///
/// `bidCommitment` used to bind `bidId`, which a bidder could only learn after
/// `commitBid` returned. Predicting it meant reading `committedBidCount()`
/// first, so two wallets in the same block both committed to the same id and
/// one of them was wrong.
///
/// Worse, `processReveals` reverted on a commitment mismatch while `finalize`
/// required every committed bid to be processed - so one unrevealable bid meant
/// the auction could never settle. Since `commitBid` cannot inspect a sealed
/// commitment, anyone could halt any auction with one wei of escrow.
///
/// These tests now assert the corrected behaviour and exist so it cannot
/// regress.
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
        revealDeadline = endTime + 4 hours;
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

    function _commit(SealedBidAuction a, address who, uint256 qty, uint16 tick)
        internal
        returns (uint32 actualId)
    {
        uint256 escrow = AuctionMath.escrowFor(qty, RESERVE, TICK, tick, SALE_DEC);
        quote.mint(who, escrow);
        // Computed from values the bidder already holds. No counter is read,
        // so there is nothing to race.
        bytes32 c = a.bidCommitment(who, qty, tick, keccak256("salt"), 1);
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

    /// Two bidders in the same block. Both commitments must remain valid
    /// whichever order they land in.
    function test_concurrentBiddersBothKeepValidCommitments() public {
        SealedBidAuction a = _open();

        uint32 aliceId = _commit(a, alice, 10e18, 3);
        uint32 bobId = _commit(a, bob, 10e18, 3);

        assertEq(aliceId, 0);
        assertEq(bobId, 1);

        // Each stored commitment is exactly what the reveal will recompute,
        // regardless of which id they landed on.
        assertEq(
            a.getBid(aliceId).commitment,
            a.bidCommitment(alice, 10e18, 3, keccak256("salt"), 1),
            "alice's commitment must survive the ordering"
        );
        assertEq(
            a.getBid(bobId).commitment,
            a.bidCommitment(bob, 10e18, 3, keccak256("salt"), 1),
            "bob's commitment must survive the ordering"
        );
    }

    /// A junk commitment must cost only the griefer, and must not stop the
    /// auction from settling.
    function test_junkCommitmentIsVoidedAndTheAuctionStillSettles() public {
        SealedBidAuction a = _open();

        _commit(a, alice, 10e18, 3);

        // The griefer posts a commitment to nothing at all, for one wei.
        quote.mint(griefer, 1);
        vm.startPrank(griefer);
        quote.approve(address(a), 1);
        a.commitBid(keccak256("junk"), keccak256("ct-junk"), 1, new bytes32[](0));
        vm.stopPrank();

        vm.warp(endTime);
        a.closeCommit();

        // The committee attests a leaf for BOTH bids - it must, since the root
        // has to cover committedBidCount. For the junk bid there is no real
        // plaintext, so whatever it attests simply will not match.
        bytes32 leafA = a.revealLeaf(0, 10e18, 3, keccak256("salt"));
        bytes32 leafJunk = a.revealLeaf(1, 0, 0, bytes32(0));
        bytes32 root = _hashPair(leafA, leafJunk);
        a.registerRevealRoot(root, 2, _signRoot(a, root, 2));

        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](2);
        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafJunk;
        entries[0] = SealedBidAuction.RevealEntry({
            bidId: 0, quantity: 10e18, tick: 3, salt: keccak256("salt"), bidVersion: 1, proof: proofA
        });
        bytes32[] memory proofJ = new bytes32[](1);
        proofJ[0] = leafA;
        entries[1] = SealedBidAuction.RevealEntry({
            bidId: 1, quantity: 0, tick: 0, salt: bytes32(0), bidVersion: 1, proof: proofJ
        });

        vm.expectEmit(true, true, false, false);
        emit SealedBidAuction.BidVoided(1, griefer);
        a.processReveals(entries);

        assertTrue(a.getBid(1).voided, "junk bid should be voided");
        assertFalse(a.getBid(0).voided, "alice's bid must be untouched");

        // Settlement waits out the dispute window, which the griefer cannot
        // use - they have no preimage for a commitment they invented.
        vm.expectRevert(SealedBidAuction.TooEarly.selector);
        a.finalize();

        vm.warp(block.timestamp + a.VOID_DISPUTE_WINDOW());

        // The auction settles. This is the whole point.
        a.finalize();
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Settled));
        assertGt(a.allocationOf(0), 0, "alice should be allocated");
        assertEq(a.allocationOf(1), 0, "a voided bid gets no allocation");

        // The griefer gets their wei back - denial of service is gone, and so
        // is any suggestion that voiding is confiscation.
        vm.prank(griefer);
        (uint256 tokens, uint256 refund) = a.claim(1);
        assertEq(tokens, 0);
        assertEq(refund, 1, "voided escrow is fully refundable");
    }
}

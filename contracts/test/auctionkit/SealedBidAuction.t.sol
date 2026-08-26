// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../../src/auctionkit/CommitteeRegistry.sol";
import {ClearingPrice} from "../../src/auctionkit/ClearingPrice.sol";
import {AuctionMath} from "../../src/auctionkit/AuctionMath.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Takes 1% on every transfer. The auction must refuse it rather than discover
/// the shortfall when the last bidder tries to claim.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract SealedBidAuctionTest is Test {
    SealedBidAuction impl;
    CommitteeRegistry registry;
    MockERC20 sale;
    MockERC20 quote;

    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address feeRecipient = makeAddr("feeRecipient");

    // 3-of-5 committee with known keys so the test can actually sign.
    uint256[5] committeeKeys = [uint256(0xC1), uint256(0xC2), uint256(0xC3), uint256(0xC4), uint256(0xC5)];
    address[] committee;
    bytes32 setId;

    uint8 constant SALE_DEC = 18;
    uint8 constant QUOTE_DEC = 6;
    uint256 constant ONE = 1e18;
    uint256 constant SUPPLY = 100 * ONE;
    uint256 constant RESERVE = 1e6; // 1.00 USDC
    uint256 constant TICK = 5e5; // 0.50 USDC
    uint16 constant NUM_TICKS = 4; // 1.00, 1.50, 2.00, 2.50

    uint64 startTime;
    uint64 endTime;
    uint64 revealDeadline;

    function setUp() public {
        impl = new SealedBidAuction();
        registry = new CommitteeRegistry();
        sale = new MockERC20("Sale", "SALE", SALE_DEC);
        quote = new MockERC20("Quote", "USDC", QUOTE_DEC);

        address[] memory members = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            members[i] = vm.addr(committeeKeys[i]);
        }
        // The registry rejects duplicates, and signature checking needs a
        // deterministic order; sort so the fixture is stable.
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) {
                if (members[j] < members[i]) {
                    (members[i], members[j]) = (members[j], members[i]);
                    (committeeKeys[i], committeeKeys[j]) = (committeeKeys[j], committeeKeys[i]);
                }
            }
        }
        committee = members;
        setId = registry.registerCommitteeSet(3, members);

        startTime = uint64(block.timestamp + 100);
        endTime = startTime + 1000;
        // Must exceed VOID_DISPUTE_WINDOW; a 1000-second reveal window was never
        // realistic for a threshold committee anyway.
        revealDeadline = endTime + 4 hours;
    }

    function _config() internal view returns (SealedBidAuction.Config memory) {
        return SealedBidAuction.Config({
            issuer: issuer,
            saleToken: address(sale),
            quoteToken: address(quote),
            totalSupply: SUPPLY,
            saleDecimals: SALE_DEC,
            quoteDecimals: QUOTE_DEC,
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
            protocolFeeBps: 100, // 1%
            feeRecipient: feeRecipient,
            committeeSetId: setId,
            encryptionEpoch: keccak256("epoch-1"),
            metadataHash: keccak256("meta"),
            version: 1
        });
    }

    function _deploy() internal returns (SealedBidAuction a) {
        a = SealedBidAuction(Clones.clone(address(impl)));
        a.initialize(_config(), address(registry));
    }

    function _fund(SealedBidAuction a) internal {
        sale.mint(issuer, SUPPLY);
        vm.startPrank(issuer);
        sale.approve(address(a), SUPPLY);
        a.fund();
        vm.stopPrank();
        vm.warp(startTime);
        a.openCommit();
    }

    struct BidSpec {
        address bidder;
        uint256 qty;
        uint16 tick;
        bytes32 salt;
    }

    function _commit(SealedBidAuction a, BidSpec memory s) internal returns (uint32 bidId) {
        uint256 escrow = AuctionMath.escrowFor(s.qty, RESERVE, TICK, s.tick, SALE_DEC);
        quote.mint(s.bidder, escrow);
        // No longer reads committedBidCount() first: the commitment does not
        // bind bidId, so there is nothing to predict and nothing to race.
        bytes32 commitment = a.bidCommitment(s.bidder, s.qty, s.tick, s.salt, 1);
        bidId = a.committedBidCount();
        vm.startPrank(s.bidder);
        quote.approve(address(a), escrow);
        a.commitBid(commitment, keccak256(abi.encode("ct", bidId)), escrow, new bytes32[](0));
        vm.stopPrank();
    }

    // --- merkle helpers, matching OZ's sorted-pair MerkleProof ---------------

    function _hashPair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encode(x, y)) : keccak256(abi.encode(y, x));
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
        }
        return level[0];
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        bytes32[] memory proof = new bytes32[](32);
        uint256 count = 0;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                if (i + 1 < level.length) {
                    if (i == idx) proof[count++] = level[i + 1];
                    else if (i + 1 == idx) proof[count++] = level[i];
                    next[i / 2] = _hashPair(level[i], level[i + 1]);
                } else {
                    next[i / 2] = level[i];
                }
            }
            idx = idx / 2;
            level = next;
        }
        bytes32[] memory out = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = proof[i];
        }
        return out;
    }

    function _signRoot(SealedBidAuction a, bytes32 root, uint32 count, uint256 howMany)
        internal
        view
        returns (bytes[] memory sigs)
    {
        bytes32 digest = a.revealRootDigest(root, count);
        sigs = new bytes[](howMany);
        // Members are already sorted ascending, and the contract requires the
        // signature list to be in that order.
        for (uint256 i = 0; i < howMany; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(committeeKeys[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    /// Drive an auction from open bidding through to Settled.
    function _revealAndFinalize(SealedBidAuction a, BidSpec[] memory specs) internal {
        vm.warp(endTime);
        a.closeCommit();

        bytes32[] memory leaves = new bytes32[](specs.length);
        for (uint256 i = 0; i < specs.length; i++) {
            leaves[i] = a.revealLeaf(uint32(i), specs[i].qty, specs[i].tick, specs[i].salt);
        }
        bytes32 root = _root(leaves);
        a.registerRevealRoot(root, uint32(specs.length), _signRoot(a, root, uint32(specs.length), 3));

        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](specs.length);
        for (uint256 i = 0; i < specs.length; i++) {
            entries[i] = SealedBidAuction.RevealEntry({
                bidId: uint32(i),
                quantity: specs[i].qty,
                tick: specs[i].tick,
                salt: specs[i].salt,
                bidVersion: 1,
                proof: _proof(leaves, i)
            });
        }
        a.processReveals(entries);
        a.finalize();
    }

    // =====================================================================
    // The reference example, end to end with real tokens.
    // =====================================================================

    function test_referenceExample_endToEnd() public {
        SealedBidAuction a = _deploy();
        _fund(a);

        BidSpec[] memory specs = new BidSpec[](3);
        specs[0] = BidSpec(alice, 50 * ONE, 2, keccak256("a")); // 50 @ 2.00
        specs[1] = BidSpec(bob, 70 * ONE, 1, keccak256("b")); // 70 @ 1.50
        specs[2] = BidSpec(carol, 100 * ONE, 0, keccak256("c")); // 100 @ 1.00

        for (uint256 i = 0; i < 3; i++) {
            _commit(a, specs[i]);
        }
        assertEq(a.committedBidCount(), 3);

        _revealAndFinalize(a, specs);

        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Settled), "must settle");
        assertEq(a.clearingPrice(), 1_500_000, "clearing price is 1.50 USDC");
        assertEq(a.allocationOf(0), 50 * ONE, "A gets 50");
        assertEq(a.allocationOf(1), 50 * ONE, "B gets 50");
        assertEq(a.allocationOf(2), 0, "C gets 0");

        // Claims: tokens out, refunds back, both at the uniform price.
        vm.prank(alice);
        (uint256 aTok, uint256 aRef) = a.claim(0);
        assertEq(aTok, 50 * ONE);
        assertEq(aRef, 25_000_000, "A bid 2.00, paid 1.50, refunded 25 USDC");

        vm.prank(bob);
        (uint256 bTok, uint256 bRef) = a.claim(1);
        assertEq(bTok, 50 * ONE);
        // B escrowed 70 x 1.50 = 105, paid 50 x 1.50 = 75.
        assertEq(bRef, 30_000_000, "B refunded the unfilled 20 tokens' worth");

        vm.prank(carol);
        (uint256 cTok, uint256 cRef) = a.claim(2);
        assertEq(cTok, 0);
        assertEq(cRef, 100_000_000, "C fully refunded");

        // Issuer takes proceeds net of the 1% fee.
        vm.prank(issuer);
        a.claimProceeds();
        assertEq(quote.balanceOf(feeRecipient), 1_500_000, "1% of 150 USDC");
        assertEq(quote.balanceOf(issuer), 148_500_000, "issuer nets 148.5 USDC");

        // Nothing is left stranded in the auction.
        vm.prank(issuer);
        a.claimUnsold();
        assertEq(quote.balanceOf(address(a)), 0, "quote token stranded in the auction");
        assertEq(sale.balanceOf(address(a)), 0, "sale token stranded in the auction");
    }

    // =====================================================================
    // Conservation: the property that matters most
    // =====================================================================

    function test_noTokensAreCreatedOrDestroyed() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](3);
        specs[0] = BidSpec(alice, 30 * ONE, 3, keccak256("a"));
        specs[1] = BidSpec(bob, 45 * ONE, 2, keccak256("b"));
        specs[2] = BidSpec(carol, 60 * ONE, 1, keccak256("c"));
        for (uint256 i = 0; i < 3; i++) {
            _commit(a, specs[i]);
        }
        uint256 totalEscrow = quote.balanceOf(address(a));

        _revealAndFinalize(a, specs);

        vm.prank(alice);
        a.claim(0);
        vm.prank(bob);
        a.claim(1);
        vm.prank(carol);
        a.claim(2);
        vm.prank(issuer);
        a.claimProceeds();
        vm.prank(issuer);
        a.claimUnsold();

        uint256 out = quote.balanceOf(alice) + quote.balanceOf(bob) + quote.balanceOf(carol)
            + quote.balanceOf(issuer) + quote.balanceOf(feeRecipient);
        assertEq(out, totalEscrow, "quote in != quote out");

        uint256 saleOut = sale.balanceOf(alice) + sale.balanceOf(bob) + sale.balanceOf(carol) + sale.balanceOf(issuer);
        assertEq(saleOut, SUPPLY, "sale in != sale out");
        assertEq(quote.balanceOf(address(a)), 0);
        assertEq(sale.balanceOf(address(a)), 0);
    }

    // =====================================================================
    // Failure paths — funds must always be recoverable
    // =====================================================================

    function test_revealTimeoutRefundsEveryone() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec memory s = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, s);
        uint256 escrow = quote.balanceOf(address(a));

        vm.warp(endTime);
        a.closeCommit();

        // The committee never shows up.
        vm.warp(revealDeadline);
        a.failOnRevealTimeout(); // permissionless: anyone, not the issuer
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Failed));

        vm.prank(alice);
        (uint256 tok, uint256 ref) = a.claim(0);
        assertEq(tok, 0);
        assertEq(ref, escrow, "bidder must be made whole");

        vm.prank(issuer);
        a.claimUnsold();
        assertEq(sale.balanceOf(issuer), SUPPLY, "issuer gets the whole supply back");
    }

    function test_noBidsFailsSafely() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        vm.warp(endTime);
        a.closeCommit();
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Failed));
        vm.prank(issuer);
        a.claimUnsold();
        assertEq(sale.balanceOf(issuer), SUPPLY);
    }

    function test_issuerCannotClaimProceedsBeforeSettlement() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        _commit(a, BidSpec(alice, 10 * ONE, 2, keccak256("a")));
        vm.prank(issuer);
        vm.expectRevert();
        a.claimProceeds();
    }

    function test_noDoubleClaim() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, specs[0]);
        _revealAndFinalize(a, specs);

        vm.prank(alice);
        a.claim(0);
        vm.prank(alice);
        vm.expectRevert(SealedBidAuction.AlreadyClaimed.selector);
        a.claim(0);
    }

    function test_noDoubleProceedsClaim() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, specs[0]);
        _revealAndFinalize(a, specs);
        vm.prank(issuer);
        a.claimProceeds();
        vm.prank(issuer);
        vm.expectRevert(SealedBidAuction.AlreadyClaimed.selector);
        a.claimProceeds();
    }

    // =====================================================================
    // Committee / reveal integrity
    // =====================================================================

    function test_belowThresholdSignaturesRejected() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, specs[0]);
        vm.warp(endTime);
        a.closeCommit();

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, specs[0].qty, specs[0].tick, specs[0].salt);
        bytes32 root = _root(leaves);

        // Two of five is not three of five. Signatures are built first: _signRoot
        // makes an external call to the auction, and vm.expectRevert binds to
        // the very next external call, which would be that one.
        bytes[] memory sigs = _signRoot(a, root, 1, 2);
        vm.expectRevert(abi.encodeWithSelector(SealedBidAuction.InsufficientSignatures.selector, 2, 3));
        a.registerRevealRoot(root, 1, sigs);
    }

    function test_duplicateSignerCannotFakeThreshold() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, specs[0]);
        vm.warp(endTime);
        a.closeCommit();

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, specs[0].qty, specs[0].tick, specs[0].salt);
        bytes32 root = _root(leaves);
        bytes32 digest = a.revealRootDigest(root, 1);

        // One operator signing three times must not satisfy a 3-of-5 threshold.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(committeeKeys[0], digest);
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = abi.encodePacked(r, s, v);
        sigs[1] = sigs[0];
        sigs[2] = sigs[0];

        vm.expectRevert(SealedBidAuction.SignersNotSorted.selector);
        a.registerRevealRoot(root, 1, sigs);
    }

    function test_nonMemberSignatureRejected() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        _commit(a, specs[0]);
        vm.warp(endTime);
        a.closeCommit();

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, specs[0].qty, specs[0].tick, specs[0].salt);
        bytes32 root = _root(leaves);
        bytes32 digest = a.revealRootDigest(root, 1);

        // Two real members plus an outsider whose address sorts last.
        bytes[] memory sigs = new bytes[](3);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(committeeKeys[0], digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(committeeKeys[1], digest);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);

        uint256 outsiderKey = 0xBADBEEF;
        while (vm.addr(outsiderKey) <= vm.addr(committeeKeys[1])) {
            outsiderKey++;
        }
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(outsiderKey, digest);
        sigs[2] = abi.encodePacked(r2, s2, v2);

        vm.expectRevert(
            abi.encodeWithSelector(SealedBidAuction.NotCommitteeMember.selector, vm.addr(outsiderKey))
        );
        a.registerRevealRoot(root, 1, sigs);
    }

    function test_committeeCannotSubstituteADifferentPlaintext() public {
        // The property the whole commitment scheme exists for. A committee that
        // signs a root over a bid with different parameters cannot get it past
        // the onchain commitment the bidder posted before the close.
        //
        // The substituted bid is no longer *rejected inline* - that behaviour
        // let anyone kill an auction with one junk commitment, see
        // BidIdRace.t.sol. It is voided instead, and alice then produces the
        // preimage the committee could not, which halts the auction. The
        // committee still cannot make a forged bid count.
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec memory real = BidSpec(alice, 10 * ONE, 1, keccak256("a"));
        _commit(a, real);
        vm.warp(endTime);
        a.closeCommit();

        // The committee attests to a *higher* tick than alice actually bid.
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, real.qty, 3, real.salt);
        bytes32 root = _root(leaves);
        a.registerRevealRoot(root, 1, _signRoot(a, root, 1, 3));

        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](1);
        entries[0] = SealedBidAuction.RevealEntry({
            bidId: 0,
            quantity: real.qty,
            tick: 3, // forged
            salt: real.salt,
            bidVersion: 1,
            proof: _proof(leaves, 0)
        });

        // The merkle proof is valid — but the salted commitment is not, so the
        // forged bid is voided rather than counted.
        a.processReveals(entries);
        assertTrue(a.getBid(0).voided, "forged reveal must not count as revealed");
        assertEq(a.allocationOf(0), 0);

        // Settlement cannot race the dispute.
        vm.expectRevert(SealedBidAuction.TooEarly.selector);
        a.finalize();

        // Alice holds a preimage matching what she posted. The committee does
        // not, because it made its leaf up.
        a.disputeVoid(0, real.qty, real.tick, real.salt, 1);
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Failed));

        // She gets her escrow back in full.
        uint256 before = quote.balanceOf(alice);
        vm.prank(alice);
        (uint256 tokens, uint256 refund) = a.claim(0);
        assertEq(tokens, 0);
        assertEq(quote.balanceOf(alice), before + refund);
        assertGt(refund, 0);
    }

    /// A griefer cannot use the dispute path: they never had a preimage.
    function test_grieferCannotDisputeTheirOwnJunkCommitment() public {
        SealedBidAuction a = _deploy();
        _fund(a);

        quote.mint(dave, 1);
        vm.startPrank(dave);
        quote.approve(address(a), 1);
        a.commitBid(keccak256("junk"), keccak256("ctj"), 1, new bytes32[](0));
        vm.stopPrank();

        vm.warp(endTime);
        a.closeCommit();
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, 0, 0, bytes32(0));
        bytes32 root = _root(leaves);
        a.registerRevealRoot(root, 1, _signRoot(a, root, 1, 3));

        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](1);
        entries[0] = SealedBidAuction.RevealEntry({
            bidId: 0, quantity: 0, tick: 0, salt: bytes32(0), bidVersion: 1, proof: _proof(leaves, 0)
        });
        a.processReveals(entries);
        assertTrue(a.getBid(0).voided);

        // Nothing they can supply matches keccak256("junk").
        vm.expectRevert(SealedBidAuction.CommitmentMismatch.selector);
        a.disputeVoid(0, 1 * ONE, 0, bytes32(0), 1);
    }

    function test_omittedBidBlocksSettlement() public {
        // Committee censorship must halt the auction, never silently move the
        // clearing price by leaving a bid out.
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](2);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        specs[1] = BidSpec(bob, 10 * ONE, 1, keccak256("b"));
        _commit(a, specs[0]);
        _commit(a, specs[1]);
        vm.warp(endTime);
        a.closeCommit();

        // A root covering only one of the two committed bids.
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = a.revealLeaf(0, specs[0].qty, specs[0].tick, specs[0].salt);
        bytes32 root = _root(leaves);
        bytes[] memory sigs = _signRoot(a, root, 1, 3);
        vm.expectRevert(abi.encodeWithSelector(SealedBidAuction.RevealIncomplete.selector, 1, 2));
        a.registerRevealRoot(root, 1, sigs);
    }

    function test_cannotFinalizeWithUnprocessedBids() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](2);
        specs[0] = BidSpec(alice, 10 * ONE, 2, keccak256("a"));
        specs[1] = BidSpec(bob, 10 * ONE, 1, keccak256("b"));
        _commit(a, specs[0]);
        _commit(a, specs[1]);
        vm.warp(endTime);
        a.closeCommit();

        bytes32[] memory leaves = new bytes32[](2);
        for (uint256 i = 0; i < 2; i++) {
            leaves[i] = a.revealLeaf(uint32(i), specs[i].qty, specs[i].tick, specs[i].salt);
        }
        bytes32 root = _root(leaves);
        a.registerRevealRoot(root, 2, _signRoot(a, root, 2, 3));

        // Only process one of the two.
        SealedBidAuction.RevealEntry[] memory entries = new SealedBidAuction.RevealEntry[](1);
        entries[0] = SealedBidAuction.RevealEntry(0, specs[0].qty, specs[0].tick, specs[0].salt, 1, _proof(leaves, 0));
        a.processReveals(entries);

        vm.expectRevert(abi.encodeWithSelector(SealedBidAuction.RevealIncomplete.selector, 1, 2));
        a.finalize();
    }

    function test_revealCannotBeRegisteredBeforeClose() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        _commit(a, BidSpec(alice, 10 * ONE, 2, keccak256("a")));
        // Still CommitOpen.
        vm.expectRevert();
        a.registerRevealRoot(keccak256("x"), 1, new bytes[](3));
    }

    // =====================================================================
    // Lifecycle and access control
    // =====================================================================

    function test_noBidsAfterClose() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        vm.warp(endTime);
        quote.mint(alice, 1e12);
        vm.startPrank(alice);
        quote.approve(address(a), 1e12);
        vm.expectRevert(SealedBidAuction.TooLate.selector);
        a.commitBid(keccak256("c"), keccak256("ct"), 1e12, new bytes32[](0));
        vm.stopPrank();
    }

    function test_issuerCannotCancelOnceBidsExist() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        _commit(a, BidSpec(alice, 10 * ONE, 2, keccak256("a")));
        vm.prank(issuer);
        vm.expectRevert();
        a.cancel();
    }

    function test_issuerCanCancelBeforeAnyBid() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        vm.prank(issuer);
        a.cancel();
        assertEq(uint256(a.state()), uint256(SealedBidAuction.State.Cancelled));
        assertEq(sale.balanceOf(issuer), SUPPLY, "supply returned on cancel");
    }

    function test_onlyIssuerCanCancelOrClaim() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        vm.prank(alice);
        vm.expectRevert(SealedBidAuction.NotIssuer.selector);
        a.cancel();
        vm.prank(alice);
        vm.expectRevert(SealedBidAuction.NotIssuer.selector);
        a.claimUnsold();
    }

    function test_cannotBidBeforeFunding() public {
        SealedBidAuction a = SealedBidAuction(Clones.clone(address(impl)));
        a.initialize(_config(), address(registry));
        vm.warp(startTime);
        vm.expectRevert();
        a.openCommit(); // still Created, not Funded
    }

    function test_feeOnTransferSaleTokenRejected() public {
        FeeOnTransferToken bad = new FeeOnTransferToken();
        SealedBidAuction.Config memory cfg = _config();
        cfg.saleToken = address(bad);
        SealedBidAuction a = SealedBidAuction(Clones.clone(address(impl)));
        a.initialize(cfg, address(registry));

        bad.mint(issuer, SUPPLY * 2);
        vm.startPrank(issuer);
        bad.approve(address(a), SUPPLY);
        vm.expectRevert(SealedBidAuction.FeeOnTransferToken.selector);
        a.fund();
        vm.stopPrank();
    }

    function test_committeeSetIsImmutable() public view {
        // Registering the same content twice returns the same id, and there is
        // no update path — so an auction's committee cannot change under it.
        CommitteeRegistry.CommitteeSet memory s = registry.getCommitteeSet(setId);
        assertEq(s.threshold, 3);
        assertEq(s.members.length, 5);
    }

    function test_registryRejectsImpossibleThreshold() public {
        address[] memory m = new address[](2);
        m[0] = address(1);
        m[1] = address(2);
        vm.expectRevert(CommitteeRegistry.InvalidThreshold.selector);
        registry.registerCommitteeSet(3, m);
    }

    function test_registryRejectsDuplicateMembers() public {
        address[] memory m = new address[](2);
        m[0] = address(1);
        m[1] = address(1);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.DuplicateMember.selector, address(1)));
        registry.registerCommitteeSet(2, m);
    }

    // =====================================================================
    // Undersubscribed
    // =====================================================================

    function test_undersubscribedFillsAtReserveAndReturnsUnsold() public {
        SealedBidAuction a = _deploy();
        _fund(a);
        BidSpec[] memory specs = new BidSpec[](1);
        specs[0] = BidSpec(alice, 10 * ONE, 3, keccak256("a")); // wants 10 of 100
        _commit(a, specs[0]);
        _revealAndFinalize(a, specs);

        assertEq(a.clearingPrice(), RESERVE, "undersubscribed clears at the reserve");
        assertEq(a.allocationOf(0), 10 * ONE);

        vm.prank(alice);
        (uint256 tok, uint256 ref) = a.claim(0);
        assertEq(tok, 10 * ONE);
        // Escrowed at 2.50, paid at 1.00.
        assertEq(ref, 25_000_000 - 10_000_000);

        vm.prank(issuer);
        a.claimUnsold();
        assertEq(sale.balanceOf(issuer), 90 * ONE, "90 unsold returned");
    }
}

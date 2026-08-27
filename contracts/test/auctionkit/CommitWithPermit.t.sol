// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../../src/auctionkit/CommitteeRegistry.sol";
import {PermitToken} from "../../src/auctionkit/PermitToken.sol";
import {AuctionMath} from "../../src/auctionkit/AuctionMath.sol";

contract CommitWithPermitTest is Test {
    SealedBidAuction auction;
    PermitToken sale;
    PermitToken quote;

    uint256 bidderKey = 0xB1D;
    address bidder;
    address issuer = makeAddr("issuer");
    address griefer = makeAddr("griefer");

    uint256 constant SUPPLY = 1000e18;
    uint256 constant RESERVE = 1e18;
    uint256 constant TICK = 1e17;
    uint64 endTime;

    function setUp() public {
        bidder = vm.addr(bidderKey);
        CommitteeRegistry registry = new CommitteeRegistry();
        address[] memory m = new address[](5);
        for (uint256 i = 0; i < 5; i++) m[i] = vm.addr(uint256(keccak256(abi.encodePacked("k", i))));
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) if (m[j] < m[i]) (m[i], m[j]) = (m[j], m[i]);
        }
        bytes32 setId = registry.registerCommitteeSet(3, m);

        sale = new PermitToken("Sale", "SALE", address(this));
        quote = new PermitToken("Quote", "QUOTE", address(this));

        auction = SealedBidAuction(Clones.clone(address(new SealedBidAuction())));
        uint64 start = uint64(block.timestamp);
        endTime = start + 3600;
        auction.initialize(
            SealedBidAuction.Config({
                issuer: issuer, saleToken: address(sale), quoteToken: address(quote),
                totalSupply: SUPPLY, saleDecimals: 18, quoteDecimals: 18,
                reservePrice: RESERVE, tickSize: TICK, numTicks: 32,
                startTime: start, endTime: endTime, revealDeadline: endTime + 4 hours,
                minBidQuantity: 1e18, maxQuantityPerAddress: 0, maxBids: 256,
                allowlistRoot: bytes32(0), protocolFeeBps: 0, feeRecipient: issuer,
                committeeSetId: setId, encryptionEpoch: keccak256("e"),
                metadataHash: keccak256("m"), voidDisputeWindow: 1 hours, version: 1
            }),
            address(registry)
        );

        sale.mint(issuer, SUPPLY);
        vm.startPrank(issuer);
        sale.approve(address(auction), SUPPLY);
        auction.fund();
        vm.stopPrank();
        auction.openCommit();
    }

    /// Sign an EIP-2612 permit the way a wallet would.
    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                bidder, address(auction), value, quote.nonces(bidder), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", quote.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(bidderKey, digest);
    }

    /// The point of the whole change: one transaction, no prior approve.
    function test_bidsInOneTransactionWithNoApproval() public {
        uint256 escrow = AuctionMath.escrowFor(10e18, RESERVE, TICK, 3, 18);
        quote.mint(bidder, escrow);
        assertEq(quote.allowance(bidder, address(auction)), 0, "no allowance to start");

        (uint8 v, bytes32 r, bytes32 s) = _permit(escrow, block.timestamp + 3600);
        vm.prank(bidder);
        uint32 id = auction.commitBidWithPermit(
            keccak256("c"), keccak256("ct"), escrow, new bytes32[](0), block.timestamp + 3600, v, r, s
        );

        assertEq(id, 0);
        assertEq(quote.balanceOf(address(auction)), escrow, "escrow moved");
        assertEq(auction.committedBidCount(), 1);
    }

    /// A permit signature is public once broadcast. Anyone can submit it first,
    /// consume the nonce, and leave the real transaction reverting on a permit
    /// that has already been used. The bid must still land.
    function test_survivesAFrontRunPermit() public {
        uint256 escrow = AuctionMath.escrowFor(10e18, RESERVE, TICK, 3, 18);
        quote.mint(bidder, escrow);
        uint256 deadline = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = _permit(escrow, deadline);

        // The griefer replays the signature before the bidder's own tx lands.
        vm.prank(griefer);
        quote.permit(bidder, address(auction), escrow, deadline, v, r, s);
        assertEq(quote.allowance(bidder, address(auction)), escrow, "allowance already set");

        // The same signature now fails, and the bid goes through regardless.
        vm.prank(bidder);
        uint32 id = auction.commitBidWithPermit(
            keccak256("c"), keccak256("ct"), escrow, new bytes32[](0), deadline, v, r, s
        );
        assertEq(id, 0, "the bid must still land");
        assertEq(quote.balanceOf(address(auction)), escrow);
    }

    /// Swallowing the permit failure must not swallow a missing allowance. With
    /// no permit and no approve there is nothing to spend, and it must revert.
    function test_stillRevertsWhenThereIsNoAllowanceAtAll() public {
        uint256 escrow = AuctionMath.escrowFor(10e18, RESERVE, TICK, 3, 18);
        quote.mint(bidder, escrow);

        vm.prank(bidder);
        vm.expectRevert();
        auction.commitBidWithPermit(
            keccak256("c"), keccak256("ct"), escrow, new bytes32[](0),
            block.timestamp + 3600, 27, bytes32(uint256(1)), bytes32(uint256(2))
        );
    }

    /// A permit signed by someone else must not fund this bidder's escrow.
    function test_aStrangersPermitDoesNotWork() public {
        uint256 escrow = AuctionMath.escrowFor(10e18, RESERVE, TICK, 3, 18);
        quote.mint(griefer, escrow);
        (uint8 v, bytes32 r, bytes32 s) = _permit(escrow, block.timestamp + 3600);

        vm.prank(griefer);
        vm.expectRevert();
        auction.commitBidWithPermit(
            keccak256("c"), keccak256("ct"), escrow, new bytes32[](0), block.timestamp + 3600, v, r, s
        );
    }

    /// The old path has to keep working: tokens without permit still exist.
    function test_plainCommitBidStillWorks() public {
        uint256 escrow = AuctionMath.escrowFor(10e18, RESERVE, TICK, 3, 18);
        quote.mint(bidder, escrow);
        vm.startPrank(bidder);
        quote.approve(address(auction), escrow);
        uint32 id = auction.commitBid(keccak256("c"), keccak256("ct"), escrow, new bytes32[](0));
        vm.stopPrank();
        assertEq(id, 0);
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";

/// @notice Emits ground-truth vectors for the TypeScript client.
///
/// `packages/auctionkit` recomputes `bidCommitment` off-chain so a bidder can
/// build one before submitting. If the two ever disagree, every bid becomes
/// unrevealable — the client would produce a commitment the contract refuses
/// to match, and the bid would be voided at reveal.
///
/// So the TS test pins what this prints rather than trusting that two
/// implementations of the same abi.encode happen to agree.
///
/// Run: forge test --match-contract CommitmentVectors -vv
contract CommitmentVectorsTest is Test {
    function test_emitVectors() public {
        console2.log("BID_COMMITMENT_TYPEHASH");
        console2.logBytes32(new SealedBidAuction().BID_COMMITMENT_TYPEHASH());

        // A fixed chain and auction address so the vector is reproducible.
        vm.chainId(560048);
        SealedBidAuction a = SealedBidAuction(address(0x1111111111111111111111111111111111111111));
        vm.etch(address(a), address(new SealedBidAuction()).code);

        bytes32 c = a.bidCommitment(
            address(0x2222222222222222222222222222222222222222),
            1234567890123456789,
            7,
            bytes32(uint256(0xabcdef)),
            1
        );
        console2.log("chainId 560048, auction 0x1111...11, bidder 0x2222...22");
        console2.log("quantity 1234567890123456789, tick 7, salt 0xabcdef, version 1");
        console2.log("bidCommitment");
        console2.logBytes32(c);
    }
}

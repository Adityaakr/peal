// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {SealedBidAuction} from "../../src/auctionkit/SealedBidAuction.sol";

/// @notice Ground truth for the Vara.eth reveal engine.
///
/// The engine recomputes the reveal root off-chain so the committee's
/// arithmetic can be checked rather than trusted. That is only worth anything
/// if its root is byte-identical to what this contract verifies, so the Rust
/// side pins what this prints.
///
/// Run: forge test --match-contract RevealVectors -vv
contract RevealVectorsTest is Test {
    function _hashPair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encode(x, y)) : keccak256(abi.encode(y, x));
    }

    function test_emitRevealVectors() public {
        SealedBidAuction a = new SealedBidAuction();

        // Three bids, the shape the demo actually uses.
        uint32[3] memory ids = [uint32(0), 1, 2];
        uint256[3] memory qty = [uint256(120_000 ether), 300_000 ether, 450_000 ether];
        uint16[3] memory ticks = [uint16(18), 12, 7];
        bytes32[3] memory salts = [
            keccak256("peal-demo-salt-0"),
            keccak256("peal-demo-salt-1"),
            keccak256("peal-demo-salt-2")
        ];

        bytes32[] memory leaves = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            leaves[i] = a.revealLeaf(ids[i], qty[i], ticks[i], salts[i]);
            console2.log("leaf", i);
            console2.logBytes32(leaves[i]);
        }

        // Odd node promoted, matching the engine and the Solidity test helper.
        bytes32 root = _hashPair(_hashPair(leaves[0], leaves[1]), leaves[2]);
        console2.log("root");
        console2.logBytes32(root);

        for (uint256 i = 0; i < 3; i++) {
            console2.log("salt", i);
            console2.logBytes32(salts[i]);
        }
    }
}

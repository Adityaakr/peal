// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PealLinksGateway} from "../../src/links/PealLinksGateway.sol";

/// Cross-check: the node's Rust EIP-712 digest (crates/peal-links-node/src/
/// settlement.rs, test digest_is_stable) must equal the contract's for the
/// same inputs, with the contract at the fixed address the Rust test uses.
contract DigestTest is Test {
    function test_withdrawal_digest_matches_node() public {
        address at = address(0x1234);
        address[] memory signers = new address[](1);
        signers[0] = address(0xBEEF);
        deployCodeTo("PealLinksGateway.sol:PealLinksGateway", abi.encode(address(0xA11CE), signers, uint256(1)), at);
        PealLinksGateway gw = PealLinksGateway(at);
        vm.chainId(31337);
        PealLinksGateway.Withdrawal memory w = PealLinksGateway.Withdrawal({
            chainId: 31337,
            gateway: at,
            token: address(0x5678),
            recipient: address(0xAB),
            amount: 12500000,
            withdrawalId: bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111"),
            epoch: 1
        });
        assertEq(gw.withdrawalDigest(w), bytes32(0x448ccadafdadd5b3803d0d0c940a2da127996e7d588ffc1b5987335bb9ce35ea));
    }
}

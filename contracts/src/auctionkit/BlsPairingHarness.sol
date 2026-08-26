// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BlsPairing} from "./BlsPairing.sol";

/// @notice External wrapper so gas can be attributed to a real call frame and
///         `vm.expectRevert` binds to the library rather than to the test.
contract BlsPairingHarness {
    function check(bytes calldata input) external view returns (bool) {
        return BlsPairing.check(input);
    }

    /// @notice Measures only the pairing call, excluding calldata and dispatch.
    function checkGas(bytes calldata input) external view returns (uint256 used, bool ok) {
        uint256 before = gasleft();
        ok = BlsPairing.check(input);
        used = before - gasleft();
    }
}

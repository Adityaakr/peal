// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PealNames} from "../src/PealNames.sol";

/// @notice Deploy the short-link registry.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  the broadcasting key
///
/// The contract has no owner, no admin and no upgrade path, so this script is
/// the whole of it: there is nothing to configure afterwards and nothing anyone
/// can change later. It is cheap to redeploy and impossible to migrate, since
/// every name already claimed belongs to the address it was claimed at. A
/// second deployment is a second namespace rather than a replacement, which is
/// why the resulting address is written into source
/// (packages/explorer/src/live-names.ts) rather than into an environment
/// variable somebody can point somewhere else.
///
///   forge script script/DeployPealNames.s.sol --rpc-url tempo --broadcast
contract DeployPealNames is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        PealNames names = new PealNames();
        vm.stopBroadcast();

        console2.log("PealNames", address(names));
    }
}

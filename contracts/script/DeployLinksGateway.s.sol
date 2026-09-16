// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PealLinksGateway} from "../src/links/PealLinksGateway.sol";
import {DemoToken} from "../src/DemoToken.sol";

/// Deploy a Peal Links gateway and, on a local or test chain, a demo token
/// it accepts. Reads:
///   LINKS_OWNER      gateway owner (pause, token config, signer rotation)
///   LINKS_SIGNERS    comma-separated signer addresses (sorted ascending)
///   LINKS_THRESHOLD  how many must sign a withdrawal
///   LINKS_TOKEN      existing token to allow (optional); if unset and
///                    LINKS_DEPLOY_DEMO_TOKEN=1, deploys DemoToken "test USD"
///   LINKS_MAX_WITHDRAWAL  per-withdrawal cap in base units (default 1e24)
///
/// Never run against a mainnet RPC as part of this build: profiles for
/// Ethereum, Base and Arbitrum exist in config only until a deployment has
/// been verified by the operator (docs/peal-links/MAINNET_READINESS.md).
contract DeployLinksGateway is Script {
    function run() external {
        address owner = vm.envAddress("LINKS_OWNER");
        address[] memory signers = vm.envAddress("LINKS_SIGNERS", ",");
        uint256 threshold = vm.envUint("LINKS_THRESHOLD");
        uint256 cap = vm.envOr("LINKS_MAX_WITHDRAWAL", uint256(1e24));

        vm.startBroadcast();
        PealLinksGateway gw = new PealLinksGateway(owner, signers, threshold);
        address token = vm.envOr("LINKS_TOKEN", address(0));
        if (token == address(0) && vm.envOr("LINKS_DEPLOY_DEMO_TOKEN", false)) {
            DemoToken t = new DemoToken("test USD", "tUSD", msg.sender);
            token = address(t);
        }
        if (token != address(0)) {
            // The deployer must be the owner for this call; otherwise the
            // owner configures the token afterwards.
            if (owner == msg.sender) gw.configureToken(token, true, cap);
        }
        vm.stopBroadcast();

        console.log("gateway", address(gw));
        console.log("token", token);
        console.log("epoch", gw.epoch());
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DemoFaucet} from "../src/auctionkit/DemoFaucet.sol";
import {DemoToken} from "../src/DemoToken.sol";

/// @notice Deploy and fill the DUSD faucet.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts; must own the demo token to fill it
///   QUOTE_TOKEN           the demo token the faucet hands out
contract DeployFaucet is Script {
    /// Enough for a large bid without letting one address empty it. The
    /// auction's supply is 1,000,000 at prices up to 4.10, so 5,000,000 covers
    /// a maximal bid with room to spare.
    uint256 constant MAX_PER_CLAIM = 5_000_000 ether;
    /// Short enough not to strand a demo, long enough to make a drain loop
    /// tedious. It is not sybil-resistant and does not pretend to be.
    uint64 constant COOLDOWN = 5 minutes;
    uint256 constant INITIAL_FILL = 500_000_000 ether;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        DemoToken quote = DemoToken(vm.envAddress("QUOTE_TOKEN"));

        vm.startBroadcast(pk);
        DemoFaucet faucet = new DemoFaucet(IERC20(address(quote)), MAX_PER_CLAIM, COOLDOWN);
        quote.mint(address(faucet), INITIAL_FILL);
        vm.stopBroadcast();

        console2.log("faucet      ", address(faucet));
        console2.log("token       ", address(quote));
        console2.log("maxPerClaim ", MAX_PER_CLAIM);
        console2.log("cooldown    ", COOLDOWN);
        console2.log("balance     ", faucet.balance());
        console2.log(
            string.concat('{"faucet":"', vm.toString(address(faucet)), '","maxPerClaim":"', vm.toString(MAX_PER_CLAIM), '"}')
        );
    }
}

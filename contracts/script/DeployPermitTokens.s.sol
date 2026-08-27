// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {PermitToken} from "../src/auctionkit/PermitToken.sol";
import {DemoFaucet} from "../src/auctionkit/DemoFaucet.sol";

/// @notice Permit-capable demo tokens, plus a faucet for the quote side.
///
/// The existing DUSD is a hand-rolled DemoToken with no permit, so auctions
/// quoted in it will always cost a bidder two transactions. These are the
/// defaults for new auctions: same demo money, one prompt instead of two.
contract DeployPermitTokens is Script {
    uint256 constant MAX_PER_CLAIM = 5_000_000 ether;
    uint64 constant COOLDOWN = 5 minutes;
    uint256 constant FILL = 500_000_000 ether;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        PermitToken sale = new PermitToken("Peal Demo Sale", "PEALD", deployer);
        PermitToken quote = new PermitToken("Peal Demo USD", "DUSD", deployer);
        DemoFaucet faucet = new DemoFaucet(IERC20(address(quote)), MAX_PER_CLAIM, COOLDOWN);
        quote.mint(address(faucet), FILL);
        vm.stopBroadcast();

        console2.log("saleToken ", address(sale));
        console2.log("quoteToken", address(quote));
        console2.log("faucet    ", address(faucet));
    }
}

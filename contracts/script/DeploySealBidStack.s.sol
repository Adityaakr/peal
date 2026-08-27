// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {AuctionFactory} from "../src/auctionkit/AuctionFactory.sol";
import {SealedBidAuction} from "../src/auctionkit/SealedBidAuction.sol";
import {CommitteeRegistry} from "../src/auctionkit/CommitteeRegistry.sol";
import {PermitToken} from "../src/auctionkit/PermitToken.sol";
import {DemoFaucet} from "../src/auctionkit/DemoFaucet.sol";

/// @notice The whole SealBid stack, on any EVM chain, in one run.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts, and owns the demo tokens
///
/// Deploys implementation, registry, factory, permit-capable demo tokens and a
/// faucet, then registers the demo committee so auctions can be created
/// immediately.
///
/// The committee's keys are `keccak256("peal-demo-committee-<i>")`, derivable by
/// anyone. That is deliberate for a testnet so the demo is reproducible, and it
/// is exactly why nothing of value should sit behind it.
contract DeploySealBidStack is Script {
    uint16 constant THRESHOLD = 3;
    uint256 constant COMMITTEE_SIZE = 5;
    uint256 constant FAUCET_MAX = 5_000_000 ether;
    uint64 constant FAUCET_COOLDOWN = 5 minutes;
    uint256 constant FAUCET_FILL = 500_000_000 ether;

    function committeeKey(uint256 i) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("peal-demo-committee-", i)));
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address[] memory members = new address[](COMMITTEE_SIZE);
        for (uint256 i = 0; i < COMMITTEE_SIZE; ++i) members[i] = vm.addr(committeeKey(i));

        vm.startBroadcast(pk);

        CommitteeRegistry registry = new CommitteeRegistry();
        bytes32 setId = registry.registerCommitteeSet(THRESHOLD, members);

        SealedBidAuction impl = new SealedBidAuction();
        AuctionFactory factory = new AuctionFactory(address(impl), registry);

        PermitToken sale = new PermitToken("Peal Demo Sale", "PEALD", deployer);
        PermitToken quote = new PermitToken("Peal Demo USD", "DUSD", deployer);

        DemoFaucet faucet = new DemoFaucet(IERC20(address(quote)), FAUCET_MAX, FAUCET_COOLDOWN);
        quote.mint(address(faucet), FAUCET_FILL);
        sale.mint(deployer, FAUCET_FILL);

        vm.stopBroadcast();

        console2.log("chainId       ", block.chainid);
        console2.log("deployedBlock ", block.number);
        console2.log("registry      ", address(registry));
        console2.log("implementation", address(impl));
        console2.log("factory       ", address(factory));
        console2.log("saleToken     ", address(sale));
        console2.log("quoteToken    ", address(quote));
        console2.log("faucet        ", address(faucet));
        console2.log("committeeSetId");
        console2.logBytes32(setId);
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {SwapPool, IERC20} from "../src/SwapPool.sol";
import {PublicBuilder} from "../src/PublicBuilder.sol";
import {PealMempool} from "../src/PealMempool.sol";

/// @notice Deploy the encrypted-mempool demo to Tempo (or any EVM chain).
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts; also the token owner and the coordinator
///   RELAYER_ADDRESS       gets a trading balance (sponsors visitor swaps)
///   SEARCHER_ADDRESS      gets a trading balance (the sandwich bot)
///
/// The two lanes get identical pools, seeded to BASE_RESERVE/QUOTE_RESERVE. The
/// deployer mints trading balances to the relayer and searcher, but each of
/// those must approve the pools from its own key on boot (approval can only
/// come from the token holder). Prints a JSON blob of addresses for the
/// services and the explorer to consume.
contract DeployMempool is Script {
    // SEED ONLY. These are not the live depth: relayer.ts TARGET_BASE resets
    // both pools via adminSetReserves before every swap, so whatever is seeded
    // here is overwritten within seconds. Treat it as the reseed buffer.
    //
    // This comment used to claim a deep pool left "the drama unchanged" because
    // a sandwich is bounded by the victim's slippage rather than pool depth.
    // The bound is real; the conclusion drawn from it was wrong. Extraction is
    // capped by slippage, but PROFITABILITY falls with depth: reaching the same
    // revert wall in a deeper pool needs a proportionally larger front-run, and
    // the searcher pays the fee on that whole round trip. Net is roughly
    // slippage x (swapSize - fee x depth), so the searcher stops bothering above
    // depth = swapSize / fee. At these 30,000,000 reserves and the old 0.30%
    // fee, a $10k order was unprofitable to sandwich by ~$361 and the demo
    // would have shown nothing at all. Nobody caught it because TARGET_BASE
    // discards these values before a searcher ever sees them.
    uint256 constant BASE_RESERVE = 30_000_000 ether;
    uint256 constant QUOTE_RESERVE = 10_000 ether;
    uint256 constant TRADER_USDC = 20_000_000 ether;
    uint256 constant TRADER_ETH = 5_000 ether;
    // Extra relayer balance for the before-each-swap reserve resets.
    uint256 constant RESEED_USDC = 500_000_000 ether;
    uint256 constant RESEED_ETH = 200_000 ether;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address coordinator = deployer; // deployer doubles as the settler
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address searcher = vm.envAddress("SEARCHER_ADDRESS");

        vm.startBroadcast(pk);

        DemoToken usdc = new DemoToken("Mock USDC", "mUSDC", deployer);
        DemoToken eth = new DemoToken("Mock ETH", "mETH", deployer);

        // Public lane: pool driven by an unprotected, adversarial builder. The
        // relayer is admin so it can reset reserves before each swap.
        SwapPool publicPool = new SwapPool(IERC20(address(usdc)), IERC20(address(eth)), relayer);
        PublicBuilder builder = new PublicBuilder(publicPool);
        publicPool.initOperator(address(builder));
        usdc.mint(address(publicPool), BASE_RESERVE);
        eth.mint(address(publicPool), QUOTE_RESERVE);
        publicPool.sync();

        // Peal lane: pool opened only by the sealed-batch coordinator.
        SwapPool pealPool = new SwapPool(IERC20(address(usdc)), IERC20(address(eth)), relayer);
        PealMempool mempool = new PealMempool(pealPool, coordinator);
        pealPool.initOperator(address(mempool));
        usdc.mint(address(pealPool), BASE_RESERVE);
        eth.mint(address(pealPool), QUOTE_RESERVE);
        pealPool.sync();

        // Trading balances. Approvals happen from the relayer/searcher keys. The
        // relayer also holds a large reseed buffer, since it funds the
        // before-each-swap reserve reset on both pools.
        usdc.mint(relayer, TRADER_USDC + RESEED_USDC);
        eth.mint(relayer, TRADER_ETH + RESEED_ETH);
        usdc.mint(searcher, TRADER_USDC);
        eth.mint(searcher, TRADER_ETH);

        vm.stopBroadcast();

        console2.log("{");
        console2.log('  "chainId":', block.chainid, ",");
        _line("usdc", address(usdc));
        _line("eth", address(eth));
        _line("publicPool", address(publicPool));
        _line("publicBuilder", address(builder));
        _line("pealPool", address(pealPool));
        _line("pealMempool", address(mempool));
        _line("coordinator", coordinator);
        _line("relayer", relayer);
        _lineLast("searcher", searcher);
        console2.log("}");
    }

    function _line(string memory k, address v) internal pure {
        console2.log(string.concat('  "', k, '": "'), v, '",');
    }

    function _lineLast(string memory k, address v) internal pure {
        console2.log(string.concat('  "', k, '": "'), v, '"');
    }
}

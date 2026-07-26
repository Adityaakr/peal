// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {SwapPool, IERC20} from "../src/SwapPool.sol";
import {PublicBuilder} from "../src/PublicBuilder.sol";
import {PealMempool} from "../src/PealMempool.sol";

/// Reserves and payloads here mirror the off-chain demo model in
/// packages/explorer/src/mempool/amm.ts: a $6M pool, ETH at $3,000.
contract EncryptedMempoolTest is Test {
    DemoToken usdc; // base
    DemoToken eth; // quote

    SwapPool publicPool;
    SwapPool pealPool;
    PublicBuilder builder;
    PealMempool mempool;

    address deployer = address(this);
    address coordinator = address(0xC0);
    address victim = address(0x71); // the relayer, acting for a visitor
    address searcher = address(0x5E);

    uint256 constant BASE_RESERVE = 3_000_000 ether; // mUSDC
    uint256 constant QUOTE_RESERVE = 1000 ether; // mETH

    function setUp() public {
        usdc = new DemoToken("Mock USDC", "mUSDC", deployer);
        eth = new DemoToken("Mock ETH", "mETH", deployer);

        // Public lane.
        publicPool = new SwapPool(IERC20(address(usdc)), IERC20(address(eth)), deployer);
        builder = new PublicBuilder(publicPool);
        publicPool.initOperator(address(builder));
        _seed(publicPool);

        // Peal lane.
        pealPool = new SwapPool(IERC20(address(usdc)), IERC20(address(eth)), deployer);
        mempool = new PealMempool(pealPool, coordinator);
        pealPool.initOperator(address(mempool));
        _seed(pealPool);

        // Traders hold and approve both pools.
        for (uint256 i = 0; i < 2; i++) {
            SwapPool p = i == 0 ? publicPool : pealPool;
            _fundAndApprove(victim, p);
            _fundAndApprove(searcher, p);
        }
    }

    function _seed(SwapPool pool) internal {
        usdc.mint(address(pool), BASE_RESERVE);
        eth.mint(address(pool), QUOTE_RESERVE);
        pool.sync();
    }

    function _fundAndApprove(address who, SwapPool pool) internal {
        usdc.mint(who, 1_000_000 ether);
        eth.mint(who, 1000 ether);
        vm.startPrank(who);
        usdc.approve(address(pool), type(uint256).max);
        eth.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    // ---- pool math + access ------------------------------------------------

    function test_getAmountOut_matches_constant_product() public view {
        // 50,000 USDC into a 3,000,000 / 1000 pool, 0.05% fee.
        uint256 out = publicPool.getAmountOut(50_000 ether, BASE_RESERVE, QUOTE_RESERVE);
        uint256 inWithFee = 50_000 ether * 9995;
        uint256 expected = (QUOTE_RESERVE * inWithFee) / (BASE_RESERVE * 10000 + inWithFee);
        assertEq(out, expected);
        assertGt(out, 16 ether); // ballpark 16.3 ETH
        assertLt(out, 17 ether);
    }

    function test_swap_is_operator_gated() public {
        vm.prank(searcher);
        vm.expectRevert(SwapPool.NotOperator.selector);
        publicPool.swap(searcher, true, 1 ether, 0, searcher);
    }

    function test_initOperator_is_one_shot() public {
        vm.expectRevert(SwapPool.OperatorAlreadySet.selector);
        publicPool.initOperator(address(0xdead));
    }

    // ---- public lane: the sandwich is real --------------------------------

    function test_public_honest_execute_gives_fair_fill() public {
        uint256 fair = publicPool.getAmountOut(50_000 ether, BASE_RESERVE, QUOTE_RESERVE);

        vm.prank(victim);
        bytes32 id = builder.submitOrder(
            PublicBuilder.Order(victim, true, 50_000 ether, fair, victim)
        );

        uint256 before = eth.balanceOf(victim);
        builder.execute(id);
        assertEq(eth.balanceOf(victim) - before, fair, "honest fill is the fair quote");
    }

    function test_public_sandwich_hurts_victim_and_pays_searcher() public {
        uint256 fair = publicPool.getAmountOut(50_000 ether, BASE_RESERVE, QUOTE_RESERVE);
        // Victim tolerates 1% slippage.
        uint256 minOut = (fair * 99) / 100;

        vm.prank(victim);
        bytes32 id = builder.submitOrder(
            PublicBuilder.Order(victim, true, 50_000 ether, minOut, victim)
        );

        uint256 vBefore = eth.balanceOf(victim);
        uint256 sUsdcBefore = usdc.balanceOf(searcher);

        vm.prank(searcher);
        (uint256 victimOut, uint256 profit) = builder.sandwich(id, 15_000 ether);

        assertLt(victimOut, fair, "victim got less than the fair quote");
        assertGe(victimOut, minOut, "victim still cleared its floor");
        assertEq(eth.balanceOf(victim) - vBefore, victimOut);
        assertGt(profit, 0, "searcher extracted value");
        // Searcher ends up with more USDC than it started (profit is in USDC).
        assertEq(usdc.balanceOf(searcher), sUsdcBefore + profit);
    }

    function test_public_sandwich_reverts_when_it_breaches_victim_floor() public {
        uint256 fair = publicPool.getAmountOut(50_000 ether, BASE_RESERVE, QUOTE_RESERVE);
        uint256 minOut = (fair * 999) / 1000; // a tight 0.1% floor

        vm.prank(victim);
        bytes32 id = builder.submitOrder(
            PublicBuilder.Order(victim, true, 50_000 ether, minOut, victim)
        );

        // An oversized front-run pushes the victim under its floor: the victim
        // swap reverts, and atomicity rolls the whole sandwich back.
        vm.prank(searcher);
        vm.expectRevert();
        builder.sandwich(id, 200_000 ether);
    }

    // ---- peal lane: sealed, then settled ----------------------------------

    function test_commitSealed_emits_only_the_hash() public {
        bytes32 cond = keccak256("cond-1");
        bytes32 ct = keccak256("ciphertext");
        vm.expectEmit(true, true, true, true);
        emit PealMempool.Sealed(cond, ct, victim);
        vm.prank(victim);
        mempool.commitSealed(cond, ct);
    }

    function test_peal_fill_is_fair_no_frontrun_possible() public {
        uint256 fair = pealPool.getAmountOut(50_000 ether, BASE_RESERVE, QUOTE_RESERVE);
        bytes32 cond = keccak256("cond-fair");

        PealMempool.Slot[] memory slots = new PealMempool.Slot[](1);
        slots[0] = PealMempool.Slot({
            position: 0,
            isReal: true,
            payload: abi.encode(victim, true, uint256(50_000 ether), uint256(0), victim)
        });
        bytes32 root = mempool.computeRoot(slots);

        uint256 before = eth.balanceOf(victim);
        vm.prank(coordinator);
        mempool.executeBatch(cond, slots, root);

        assertEq(eth.balanceOf(victim) - before, fair, "sealed fill is the fair quote");
        assertEq(mempool.settledRoot(cond), root);
    }

    function test_executeBatch_runs_real_slots_skips_dummy() public {
        bytes32 cond = keccak256("cond-mixed");
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](4);
        slots[0] = PealMempool.Slot(0, true, abi.encode(victim, true, uint256(20_000 ether), uint256(0), victim));
        slots[1] = PealMempool.Slot(1, false, hex"dede");
        slots[2] = PealMempool.Slot(2, true, abi.encode(searcher, true, uint256(10_000 ether), uint256(0), searcher));
        slots[3] = PealMempool.Slot(3, false, hex"abab");
        bytes32 root = mempool.computeRoot(slots);

        uint256 vBefore = eth.balanceOf(victim);
        uint256 sBefore = eth.balanceOf(searcher);
        vm.prank(coordinator);
        mempool.executeBatch(cond, slots, root);

        assertGt(eth.balanceOf(victim), vBefore, "real slot 0 executed");
        assertGt(eth.balanceOf(searcher), sBefore, "real slot 2 executed");
    }

    function test_executeBatch_root_mismatch_reverts() public {
        bytes32 cond = keccak256("cond-bad");
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](1);
        slots[0] = PealMempool.Slot(0, true, abi.encode(victim, true, uint256(1 ether), uint256(0), victim));

        vm.prank(coordinator);
        vm.expectRevert();
        mempool.executeBatch(cond, slots, keccak256("not-the-root"));
    }

    function test_executeBatch_is_coordinator_only() public {
        bytes32 cond = keccak256("cond-auth");
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](1);
        slots[0] = PealMempool.Slot(0, true, abi.encode(victim, true, uint256(1 ether), uint256(0), victim));
        bytes32 root = mempool.computeRoot(slots);

        vm.prank(searcher);
        vm.expectRevert(PealMempool.NotCoordinator.selector);
        mempool.executeBatch(cond, slots, root);
    }

    function test_executeBatch_cannot_settle_twice() public {
        bytes32 cond = keccak256("cond-twice");
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](1);
        slots[0] = PealMempool.Slot(0, true, abi.encode(victim, true, uint256(1 ether), uint256(0), victim));
        bytes32 root = mempool.computeRoot(slots);

        vm.startPrank(coordinator);
        mempool.executeBatch(cond, slots, root);
        vm.expectRevert(PealMempool.AlreadySettled.selector);
        mempool.executeBatch(cond, slots, root);
        vm.stopPrank();
    }

    // ---- merkle vs an independent python/sha256 oracle --------------------
    // Vectors computed offline (struct.pack('<I', pos) || payload, sha256 tree).

    function test_merkle_empty_matches_oracle() public view {
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](0);
        assertEq(
            mempool.computeRoot(slots),
            0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        );
    }

    function test_merkle_single_promotes_to_leaf() public view {
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](1);
        slots[0] = PealMempool.Slot(0, true, bytes("alpha"));
        assertEq(
            mempool.computeRoot(slots),
            0x44e7a99acb284b407b36a837f3b395abd876c4069a9e5a9f75fd0350ee5591f6
        );
    }

    function test_merkle_three_leaves_matches_oracle() public view {
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](3);
        slots[0] = PealMempool.Slot(0, true, bytes("alpha"));
        slots[1] = PealMempool.Slot(1, true, bytes("beta"));
        slots[2] = PealMempool.Slot(2, true, bytes("gamma"));
        assertEq(
            mempool.computeRoot(slots),
            0x339349debb92b2ac73d516f3cedb17ff38354291e1d71f17ec393aada1f7ecf7
        );
    }

    function test_merkle_mixed_real_and_dummy_matches_oracle() public view {
        address t = 0x8610be02397258E85438A6d5bd115AA89aF41eBC;
        PealMempool.Slot[] memory slots = new PealMempool.Slot[](4);
        slots[0] = PealMempool.Slot(0, true, abi.encode(t, true, uint256(50_000 ether), uint256(16 ether), t));
        slots[1] = PealMempool.Slot(1, false, _rep(0xde, 77));
        slots[2] = PealMempool.Slot(2, true, abi.encode(t, false, uint256(3 ether), uint256(9000 ether), t));
        slots[3] = PealMempool.Slot(3, false, _rep(0xab, 13));
        assertEq(
            mempool.computeRoot(slots),
            0xf272cb8f81775b8842230f43b88513476010bc9ee2f5e425a72caad95d8143dc
        );
    }

    function test_merkle_is_order_sensitive() public view {
        PealMempool.Slot[] memory ab = new PealMempool.Slot[](2);
        ab[0] = PealMempool.Slot(0, true, bytes("alpha"));
        ab[1] = PealMempool.Slot(1, true, bytes("beta"));
        PealMempool.Slot[] memory ba = new PealMempool.Slot[](2);
        ba[0] = PealMempool.Slot(1, true, bytes("beta"));
        ba[1] = PealMempool.Slot(0, true, bytes("alpha"));
        assertTrue(mempool.computeRoot(ab) != mempool.computeRoot(ba));
    }

    function _rep(uint8 b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = bytes1(b);
    }
}

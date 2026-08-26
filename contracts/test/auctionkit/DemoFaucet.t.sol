// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DemoFaucet} from "../../src/auctionkit/DemoFaucet.sol";

contract T is ERC20 {
    constructor() ERC20("t", "t") {}
    function mint(address to, uint256 v) external { _mint(to, v); }
}

contract DemoFaucetTest is Test {
    T token;
    DemoFaucet faucet;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant MAX = 1_000_000 ether;
    uint64 constant COOLDOWN = 1 hours;

    function setUp() public {
        token = new T();
        faucet = new DemoFaucet(IERC20(address(token)), MAX, COOLDOWN);
        token.mint(address(faucet), 100_000_000 ether);
    }

    function test_claimSendsTheRequestedAmount() public {
        vm.prank(alice);
        faucet.claim(250 ether);
        assertEq(token.balanceOf(alice), 250 ether);
    }

    function test_refusesMoreThanTheCap() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.AboveMaxPerClaim.selector, MAX + 1, MAX));
        faucet.claim(MAX + 1);
    }

    function test_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(DemoFaucet.AmountZero.selector);
        faucet.claim(0);
    }

    /// The bound that actually matters: one address cannot loop the faucet dry.
    function test_oneAddressCannotDrainInALoop() public {
        vm.startPrank(alice);
        faucet.claim(MAX);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.CoolingDown.selector, uint64(block.timestamp) + COOLDOWN));
        faucet.claim(1 ether);
        vm.stopPrank();
        assertEq(token.balanceOf(address(faucet)), 99_000_000 ether);
    }

    function test_claimAgainAfterCooldown() public {
        vm.startPrank(alice);
        faucet.claim(10 ether);
        skip(COOLDOWN);
        faucet.claim(10 ether);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 20 ether);
    }

    function test_separateAddressesAreIndependent() public {
        vm.prank(alice);
        faucet.claim(10 ether);
        vm.prank(bob);
        faucet.claim(10 ether);
        assertEq(token.balanceOf(bob), 10 ether);
    }

    function test_emptyFaucetSaysSoRatherThanFailingOpaquely() public {
        DemoFaucet dry = new DemoFaucet(IERC20(address(token)), MAX, COOLDOWN);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.FaucetEmpty.selector, 1 ether, 0));
        dry.claim(1 ether);
    }

    /// The view an interface uses to disable the button must agree with what
    /// `claim` will actually do.
    function test_claimableByAgreesWithClaim() public {
        (uint256 amount, uint64 at) = faucet.claimableBy(alice);
        assertEq(amount, MAX);
        assertEq(at, 0);

        vm.prank(alice);
        faucet.claim(5 ether);

        (amount, at) = faucet.claimableBy(alice);
        assertEq(amount, 0, "cooling down means nothing claimable");
        assertEq(at, uint64(block.timestamp) + COOLDOWN);

        skip(COOLDOWN);
        (amount,) = faucet.claimableBy(alice);
        assertEq(amount, MAX);
    }

    /// A nearly empty faucet should report what is left, not the cap.
    function test_claimableByIsCappedByBalance() public {
        DemoFaucet small = new DemoFaucet(IERC20(address(token)), MAX, COOLDOWN);
        token.mint(address(small), 3 ether);
        (uint256 amount,) = small.claimableBy(alice);
        assertEq(amount, 3 ether);
    }

    /// Refilling is a plain transfer. There is no privileged path to protect.
    function test_anyoneCanRefill() public {
        token.mint(bob, 5 ether);
        vm.prank(bob);
        token.transfer(address(faucet), 5 ether);
        assertEq(faucet.balance(), 100_000_005 ether);
    }
}

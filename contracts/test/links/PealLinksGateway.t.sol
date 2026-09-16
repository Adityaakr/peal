// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PealLinksGateway} from "../../src/links/PealLinksGateway.sol";

/// Minimal ERC-20 with virtual transfers, so the test tokens below can
/// misbehave in the ways the gateway must survive.
contract TestERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }
}

/// A token that skims a fee on transfer: must be refused by deposit.
contract FeeToken is TestERC20 {
    constructor() TestERC20("Fee", "FEE") {}

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        super.transferFrom(from, to, amount - fee);
        balanceOf[from] -= fee;
        totalSupply -= fee;
        return true;
    }
}

/// A token whose transfer re-enters withdraw. The guard must stop it.
contract ReenterToken is TestERC20 {
    PealLinksGateway public gw;
    PealLinksGateway.Withdrawal public w;
    bytes[] public sigs;
    bool public reentered;

    constructor() TestERC20("Re", "RE") {}

    function arm(PealLinksGateway gw_, PealLinksGateway.Withdrawal memory w_, bytes[] memory sigs_) external {
        gw = gw_;
        w = w_;
        delete sigs;
        for (uint256 i = 0; i < sigs_.length; i++) sigs.push(sigs_[i]);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (address(gw) != address(0) && !reentered) {
            reentered = true;
            // Re-enter with a fresh id so only the guard can stop it.
            PealLinksGateway.Withdrawal memory w2 = w;
            w2.withdrawalId = keccak256("second");
            try gw.withdraw(w2, sigs) {
                revert("reentrancy succeeded");
            } catch {}
        }
        return ok;
    }
}

contract PealLinksGatewayTest is Test {
    PealLinksGateway gw;
    TestERC20 token;
    address owner = address(0xA11CE);
    address alice = address(0xB0B);
    uint256[3] keys = [uint256(0x1111), uint256(0x2222), uint256(0x3333)];
    address[] signers;

    function setUp() public {
        // Sorted ascending, as withdraw requires the signatures to be.
        address[] memory s = new address[](3);
        for (uint256 i = 0; i < 3; i++) s[i] = vm.addr(keys[i]);
        _sort(s);
        signers = s;
        gw = new PealLinksGateway(owner, s, 2);
        token = new TestERC20("test USD", "tUSD");
        vm.prank(owner);
        gw.configureToken(address(token), true, 1_000_000e18);
        token.mint(alice, 1_000e18);
        token.mint(address(this), 1_000e18);
    }

    function _sort(address[] memory a) internal pure {
        for (uint256 i = 0; i < a.length; i++) {
            for (uint256 j = i + 1; j < a.length; j++) {
                if (a[j] < a[i]) (a[i], a[j]) = (a[j], a[i]);
            }
        }
    }

    function _keyFor(address signer) internal view returns (uint256) {
        for (uint256 i = 0; i < 3; i++) if (vm.addr(keys[i]) == signer) return keys[i];
        revert("unknown signer");
    }

    function _sign(PealLinksGateway.Withdrawal memory w, uint256 n) internal view returns (bytes[] memory sigs) {
        bytes32 digest = gw.withdrawalDigest(w);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyFor(signers[i]), digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    function _withdrawal(bytes32 id, uint256 amount) internal view returns (PealLinksGateway.Withdrawal memory) {
        return PealLinksGateway.Withdrawal({
            chainId: block.chainid,
            gateway: address(gw),
            token: address(token),
            recipient: alice,
            amount: amount,
            withdrawalId: id,
            epoch: gw.epoch()
        });
    }

    function _fund(uint256 amount) internal {
        token.approve(address(gw), amount);
        gw.deposit(address(token), amount, keccak256("reserve"));
    }

    // ---- deposits

    function test_deposit_emits_receipt_and_moves_exact_amount() public {
        vm.startPrank(alice);
        token.approve(address(gw), 50e18);
        vm.expectEmit(true, true, true, true);
        emit PealLinksGateway.Deposit(1, address(token), alice, 50e18, keccak256("rho"));
        uint256 id = gw.deposit(address(token), 50e18, keccak256("rho"));
        vm.stopPrank();
        assertEq(id, 1);
        assertEq(token.balanceOf(address(gw)), 50e18);
        assertEq(gw.depositCount(), 1);
    }

    function test_deposit_rejects_unallowed_token_zero_amount_and_fee_on_transfer() public {
        TestERC20 other = new TestERC20("x", "X");
        other.mint(alice, 10e18);
        vm.startPrank(alice);
        other.approve(address(gw), 10e18);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.TokenNotAllowed.selector, address(other)));
        gw.deposit(address(other), 10e18, keccak256("rho"));
        token.approve(address(gw), 10e18);
        vm.expectRevert(PealLinksGateway.ZeroAmount.selector);
        gw.deposit(address(token), 0, keccak256("rho"));
        vm.stopPrank();

        FeeToken fee = new FeeToken();
        fee.mint(alice, 100e18);
        vm.prank(owner);
        gw.configureToken(address(fee), true, 1e30);
        vm.startPrank(alice);
        fee.approve(address(gw), 100e18);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.InexactTransfer.selector, 100e18, 99e18));
        gw.deposit(address(fee), 100e18, keccak256("rho"));
        vm.stopPrank();
    }

    function test_deposit_refused_when_paused() public {
        vm.prank(owner);
        gw.pause();
        vm.startPrank(alice);
        token.approve(address(gw), 1e18);
        vm.expectRevert();
        gw.deposit(address(token), 1e18, keccak256("rho"));
        vm.stopPrank();
    }

    // ---- withdrawals

    function test_withdraw_with_threshold_releases_once() public {
        _fund(100e18);
        PealLinksGateway.Withdrawal memory w = _withdrawal(keccak256("w1"), 40e18);
        bytes[] memory sigs = _sign(w, 2);
        uint256 before = token.balanceOf(alice);
        vm.expectEmit(true, true, true, true);
        emit PealLinksGateway.Withdrawn(keccak256("w1"), address(token), alice, 40e18, 1);
        gw.withdraw(w, sigs);
        assertEq(token.balanceOf(alice) - before, 40e18);
        assertTrue(gw.consumed(keccak256("w1")));
        // Exactly once.
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.AlreadyConsumed.selector, keccak256("w1")));
        gw.withdraw(w, sigs);
    }

    function test_withdraw_needs_threshold_and_distinct_sorted_signers() public {
        _fund(100e18);
        PealLinksGateway.Withdrawal memory w = _withdrawal(keccak256("w2"), 1e18);
        bytes[] memory one = _sign(w, 1);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.NotEnoughSignatures.selector, 2, 1));
        gw.withdraw(w, one);
        // The same signer twice is not two signers.
        bytes[] memory dup = new bytes[](2);
        dup[0] = one[0];
        dup[1] = one[0];
        vm.expectRevert(PealLinksGateway.SignersNotSorted.selector);
        gw.withdraw(w, dup);
        // Unsorted order is refused too (prevents the duplicate trick).
        bytes[] memory two = _sign(w, 2);
        bytes[] memory rev = new bytes[](2);
        rev[0] = two[1];
        rev[1] = two[0];
        vm.expectRevert(PealLinksGateway.SignersNotSorted.selector);
        gw.withdraw(w, rev);
        // A stranger's signature is not a signer's.
        bytes32 digest = gw.withdrawalDigest(w);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x9999, digest);
        bytes[] memory stranger = new bytes[](2);
        stranger[0] = two[0];
        stranger[1] = abi.encodePacked(r, s, v);
        vm.expectRevert();
        gw.withdraw(w, stranger);
    }

    function test_withdraw_rejects_wrong_domain_recipient_amount_and_cap() public {
        _fund(100e18);
        PealLinksGateway.Withdrawal memory w = _withdrawal(keccak256("w3"), 10e18);
        bytes[] memory sigs = _sign(w, 2);
        // Memory structs alias on assignment, so every tampered variant is
        // built fresh.
        PealLinksGateway.Withdrawal memory t = _withdrawal(keccak256("w3"), 10e18);
        t.recipient = address(0xDEAD);
        vm.expectRevert();
        gw.withdraw(t, sigs);
        t = _withdrawal(keccak256("w3"), 11e18);
        vm.expectRevert();
        gw.withdraw(t, sigs);
        t = _withdrawal(keccak256("w3"), 10e18);
        t.chainId = 999;
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.WrongChain.selector, block.chainid, 999));
        gw.withdraw(t, sigs);
        t = _withdrawal(keccak256("w3"), 10e18);
        t.gateway = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.WrongGateway.selector, address(gw), address(0x1234)));
        gw.withdraw(t, sigs);
        // Above the per-token cap, even with valid signatures.
        vm.prank(owner);
        gw.configureToken(address(token), true, 5e18);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.AboveCap.selector, 5e18, 10e18));
        gw.withdraw(w, sigs);
    }

    function test_withdraw_rejects_stale_epoch_after_rotation() public {
        _fund(100e18);
        PealLinksGateway.Withdrawal memory w = _withdrawal(keccak256("w4"), 1e18);
        bytes[] memory sigs = _sign(w, 2);
        address[] memory next = new address[](1);
        next[0] = vm.addr(0x4444);
        vm.prank(owner);
        gw.rotateSigners(next, 1);
        assertEq(gw.epoch(), 2);
        vm.expectRevert(abi.encodeWithSelector(PealLinksGateway.StaleEpoch.selector, 2, 1));
        gw.withdraw(w, sigs);
        // The new committee can attest.
        PealLinksGateway.Withdrawal memory w2 = _withdrawal(keccak256("w5"), 1e18);
        bytes32 digest = gw.withdrawalDigest(w2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x4444, digest);
        bytes[] memory one = new bytes[](1);
        one[0] = abi.encodePacked(r, s, v);
        gw.withdraw(w2, one);
        assertTrue(gw.consumed(keccak256("w5")));
    }

    function test_withdraw_refused_when_paused_and_reentrancy_blocked() public {
        _fund(100e18);
        PealLinksGateway.Withdrawal memory w = _withdrawal(keccak256("w6"), 1e18);
        bytes[] memory sigs = _sign(w, 2);
        vm.prank(owner);
        gw.pause();
        vm.expectRevert();
        gw.withdraw(w, sigs);
        vm.prank(owner);
        gw.unpause();

        ReenterToken re = new ReenterToken();
        re.mint(address(this), 100e18);
        vm.prank(owner);
        gw.configureToken(address(re), true, 1e30);
        re.approve(address(gw), 100e18);
        gw.deposit(address(re), 100e18, keccak256("r"));
        PealLinksGateway.Withdrawal memory wr = _withdrawal(keccak256("w7"), 1e18);
        wr.token = address(re);
        bytes[] memory rs = _sign(wr, 2);
        re.arm(gw, wr, rs);
        gw.withdraw(wr, rs);
        assertTrue(re.reentered(), "callback ran");
        assertFalse(gw.consumed(keccak256("second")), "re-entrant withdrawal did not land");
        assertEq(re.balanceOf(address(gw)), 99e18);
    }

    function test_owner_cannot_move_funds_directly_and_only_owner_administers() public {
        _fund(10e18);
        // No sweep function exists; the only outflow is withdraw.
        vm.prank(alice);
        vm.expectRevert();
        gw.pause();
        vm.prank(alice);
        vm.expectRevert();
        gw.configureToken(address(token), false, 0);
        address[] memory next = new address[](1);
        next[0] = alice;
        vm.prank(alice);
        vm.expectRevert();
        gw.rotateSigners(next, 1);
        // Bad signer sets are refused.
        vm.startPrank(owner);
        vm.expectRevert(PealLinksGateway.BadSignerSet.selector);
        gw.rotateSigners(next, 2);
        address[] memory dup = new address[](2);
        dup[0] = alice;
        dup[1] = alice;
        vm.expectRevert(PealLinksGateway.BadSignerSet.selector);
        gw.rotateSigners(dup, 1);
        vm.stopPrank();
    }
}

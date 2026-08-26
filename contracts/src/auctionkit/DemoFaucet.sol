// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DemoFaucet
/// @notice Hands out testnet demo tokens so anyone can try an auction.
///
/// It **holds** a balance rather than minting. `DemoToken.owner` is immutable,
/// so minting cannot be delegated to a contract, and a faucet that had to be
/// driven by the deployer's key would mean nobody could self-serve.
///
/// ## No owner, deliberately
///
/// There is no admin, no pause, and no withdraw. An owner would be a key worth
/// stealing and a rug worth worrying about, in exchange for nothing: the only
/// thing here is demo money with no value. Refilling is a plain ERC-20 transfer
/// in, which anyone can do.
///
/// ## What stops it being drained
///
/// Two bounds, and they are the whole security model:
///
///   - `maxPerClaim` caps a single call, so one caller cannot take the lot.
///   - `cooldown` caps a single address over time.
///
/// Neither survives an attacker with unlimited fresh addresses, and that is
/// accepted rather than papered over. Sybil-resistance on a testnet faucet
/// holding valueless tokens would cost more than the thing it protects. If it
/// runs dry, someone transfers more in.
contract DemoFaucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public immutable maxPerClaim;
    uint64 public immutable cooldown;

    mapping(address => uint64) public lastClaimAt;

    event Claimed(address indexed to, uint256 amount);

    error AmountZero();
    error AboveMaxPerClaim(uint256 requested, uint256 maxAllowed);
    error CoolingDown(uint64 availableAt);
    error FaucetEmpty(uint256 requested, uint256 available);

    constructor(IERC20 token_, uint256 maxPerClaim_, uint64 cooldown_) {
        require(address(token_) != address(0), "token");
        require(maxPerClaim_ > 0, "maxPerClaim");
        token = token_;
        maxPerClaim = maxPerClaim_;
        cooldown = cooldown_;
    }

    /// @notice Send `amount` of the demo token to the caller.
    /// @dev Reverts with a specific error for each refusal, so an interface can
    ///      tell someone *why* rather than showing a generic failure.
    function claim(uint256 amount) external {
        if (amount == 0) revert AmountZero();
        if (amount > maxPerClaim) revert AboveMaxPerClaim(amount, maxPerClaim);

        uint64 last = lastClaimAt[msg.sender];
        if (last != 0 && block.timestamp < last + cooldown) {
            revert CoolingDown(last + cooldown);
        }

        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert FaucetEmpty(amount, available);

        // Effects before interactions, even though the token is known and the
        // amount is bounded: the pattern should not depend on the token being
        // well behaved.
        lastClaimAt[msg.sender] = uint64(block.timestamp);

        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice What this address could claim right now, in one call.
    /// @dev A view so an interface can disable the button and explain, rather
    ///      than letting someone send a transaction that is going to revert.
    function claimableBy(address who) external view returns (uint256 amount, uint64 availableAt) {
        uint64 last = lastClaimAt[who];
        availableAt = last == 0 ? 0 : last + cooldown;
        if (last != 0 && block.timestamp < availableAt) return (0, availableAt);

        uint256 balance = token.balanceOf(address(this));
        amount = balance < maxPerClaim ? balance : maxPerClaim;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}

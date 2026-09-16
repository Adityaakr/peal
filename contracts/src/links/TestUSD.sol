// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title TestUSD
/// @notice A six-decimal test token for Peal Links on local and test chains.
/// Anyone can mint a bounded amount per call ("faucet"), so a demo never
/// depends on a funded key. It has no value anywhere and is never put on a
/// mainnet by this repository's scripts.
contract TestUSD {
    string public constant name = "Peal test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;
    uint256 public constant FAUCET_MAX = 100_000 * 1e6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error FaucetCap();
    error InsufficientBalance();
    error InsufficientAllowance();

    function faucet(address to, uint256 amount) external {
        if (amount > FAUCET_MAX) revert FaucetCap();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a < amount) revert InsufficientAllowance();
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 b = balanceOf[from];
        if (b < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title PermitToken
/// @notice Demo token that supports EIP-2612, so bidding is one transaction.
///
/// `DemoToken` is hand-rolled, has no permit, and is shared with the encrypted
/// mempool demo. Adding permit to it would change a contract two products
/// depend on in order to serve one, so this is a separate token rather than an
/// edit. Auctions quoted in `DemoToken` keep working through `commitBid`; ones
/// quoted in this get `commitBidWithPermit`.
///
/// Owner-mintable, because it is testnet money with no value and a faucet has
/// to come from somewhere. That is also exactly why it must never be used for
/// anything else.
contract PermitToken is ERC20, ERC20Permit {
    address public immutable owner;

    error NotOwner();

    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        require(owner_ != address(0), "owner");
        owner = owner_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _mint(to, amount);
    }
}

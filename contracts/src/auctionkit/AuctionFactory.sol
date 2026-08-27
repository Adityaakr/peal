// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SealedBidAuction} from "./SealedBidAuction.sol";
import {CommitteeRegistry} from "./CommitteeRegistry.sol";

/// @title AuctionFactory
/// @notice Lets anyone create a sealed-bid auction, and makes the set of
///         auctions discoverable without a database.
///
/// ## Why the registry is onchain
///
/// The obvious place to list auctions is a server. That would make the list of
/// auctions exactly as available, and exactly as honest, as one database. For a
/// product whose whole claim is that you do not have to trust the operator, the
/// index of what exists should not be the one part you do.
///
/// So `AuctionCreated` is the registry. Anyone can reconstruct the full set by
/// reading logs from this contract's deployment block, which is a known
/// constant rather than block zero. That distinction matters: scanning from
/// zero is what made the first bid-loading implementation time out on a chain
/// a few million blocks deep.
///
/// ## Metadata
///
/// A name and a use case are strings a human wrote, and they do not belong in
/// storage where every character costs gas forever. They are emitted in the
/// event, which is cheap and permanent, and bound into the auction's own
/// `metadataHash` so the label cannot be swapped later without detection.
///
/// ## What this contract does NOT hold
///
/// No funds, no admin, no pause, no upgrade path. It deploys clones and emits
/// an event. If this contract were destroyed tomorrow every auction it created
/// would keep working, because a clone does not call back into its factory.
contract AuctionFactory {
    /// @notice The implementation every auction clones. Immutable: an auction
    ///         must not be able to change under its bidders, and an upgradable
    ///         factory would let a later deployment point at different logic
    ///         while looking identical from the outside.
    address public immutable implementation;
    CommitteeRegistry public immutable registry;

    /// @notice Auctions in creation order. The event is the canonical index;
    ///         this array is a convenience for readers that would rather make
    ///         one call than scan logs.
    address[] private _auctions;
    mapping(address => bool) public isAuction;
    mapping(address => address[]) private _byIssuer;

    /// @notice Everything a client needs to list an auction without a server.
    /// @param name       human label, chosen by the issuer
    /// @param useCase    what kind of sale this is, e.g. token-launch, dao-treasury
    /// @param details    free text, e.g. a short description or a link
    event AuctionCreated(
        address indexed auction,
        address indexed issuer,
        address indexed saleToken,
        address quoteToken,
        uint256 totalSupply,
        uint64 startTime,
        uint64 endTime,
        string name,
        string useCase,
        string details
    );

    error NotFunded();

    /// @notice Create, fund and open an auction in one transaction.
    ///
    /// @dev Funding is not left to a second call. An auction that exists but
    ///      holds no supply is a trap: it looks live, a bidder can find it, and
    ///      `commitBid` would take their escrow against tokens that were never
    ///      escrowed. Doing both here means an auction is either absent or
    ///      fully backed, with no window between.
    ///
    ///      The issuer must `approve` this factory for `totalSupply` first.
    function createAuction(
        SealedBidAuction.Config calldata cfg,
        string calldata name,
        string calldata useCase,
        string calldata details
    ) external returns (address auction) {
        // Bind the label to the auction. `metadataHash` is snapshotted into
        // immutable config, so a name shown next to an auction can be checked
        // against what its issuer actually committed to at creation.
        require(cfg.metadataHash == metadataHash(name, useCase, details), "metadata");
        // The caller is the issuer, always. Letting one address create an
        // auction owned by another would let anyone mint auctions attributed
        // to a project they do not control.
        require(cfg.issuer == msg.sender, "issuer");

        auction = Clones.clone(implementation);
        SealedBidAuction(auction).initialize(cfg, address(registry));

        // Pull the supply through this contract and into the auction. The
        // balance check is the auction's own; here we only need the transfer to
        // have happened before `fund` is called.
        IERC20 sale = IERC20(cfg.saleToken);
        _pullExact(sale, msg.sender, cfg.totalSupply);
        sale.approve(auction, cfg.totalSupply);
        SealedBidAuction(auction).fund();

        // Open immediately when the window has already started, so a bidder who
        // follows a share link straight after creation is not told the auction
        // is closed. `openCommit` is permissionless and refuses before
        // startTime, so this is a convenience rather than a privilege.
        if (block.timestamp >= cfg.startTime) SealedBidAuction(auction).openCommit();

        _auctions.push(auction);
        isAuction[auction] = true;
        _byIssuer[msg.sender].push(auction);

        emit AuctionCreated(
            auction,
            msg.sender,
            cfg.saleToken,
            cfg.quoteToken,
            cfg.totalSupply,
            cfg.startTime,
            cfg.endTime,
            name,
            useCase,
            details
        );
    }

    constructor(address implementation_, CommitteeRegistry registry_) {
        require(implementation_ != address(0) && address(registry_) != address(0), "zero");
        implementation = implementation_;
        registry = registry_;
    }

    /// @dev Balance-delta, so a fee-on-transfer token is rejected here rather
    ///      than surfacing later as an auction that cannot pay its winners.
    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        require(token.transferFrom(from, address(this), amount), "transferFrom");
        if (token.balanceOf(address(this)) - before != amount) revert NotFunded();
    }

    /// @notice The hash an issuer must put in `cfg.metadataHash`.
    /// @dev Public and pure so a client computes the same value the contract
    ///      will check, rather than guessing an encoding.
    function metadataHash(string memory name, string memory useCase, string memory details)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(name, useCase, details));
    }

    function auctionCount() external view returns (uint256) {
        return _auctions.length;
    }

    /// @notice A page of auctions, newest last. Bounded so a client cannot ask
    ///         for an unbounded array and get a response no RPC will return.
    function auctionsPaged(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _auctions.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) page[i - offset] = _auctions[i];
    }

    function auctionsOf(address issuer) external view returns (address[] memory) {
        return _byIssuer[issuer];
    }
}

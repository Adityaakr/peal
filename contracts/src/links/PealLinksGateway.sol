// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";

/// @title PealLinksGateway
/// @notice Holds the ERC-20 reserves that back one or more Peal Links
/// namespaces on this chain. Tokens enter through `deposit`, which emits the
/// receipt commitment the depositor chose; the Peal Links ledger credits the
/// deposit after its watcher observes the event with the configured number of
/// confirmations. Tokens leave through `withdraw`, which releases exactly one
/// withdrawal per unique id when a threshold of the current epoch's signers
/// has attested to it.
///
/// TRUST MODEL, STATED PLAINLY. This is a committee-attested bridge. The
/// contract verifies signatures, not proofs: it cannot tell whether a
/// withdrawal was really debited on the private ledger. A compromised or
/// colluding threshold of signers can release reserves incorrectly. The owner
/// cannot move funds directly, but the owner rotates the signer set, so
/// whoever controls the owner key controls the committee after one rotation;
/// a production deployment puts the owner behind a timelock and multisig.
/// Nothing here is a zero-knowledge settlement proof, a rollup, or trustless.
///
/// What it does enforce: allowlisted tokens with exact-amount transfers (no
/// fee-on-transfer), unique withdrawal ids, the chain id and this contract's
/// address in every attestation, the epoch of the signer set, per-token
/// withdrawal caps, pause, and reentrancy protection.
contract PealLinksGateway is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @dev One withdrawal the committee attests to. `withdrawalId` is the
    /// ledger's unique id for the debit (namespace and receipt position),
    /// consumed exactly once here.
    struct Withdrawal {
        uint256 chainId;
        address gateway;
        address token;
        address recipient;
        uint256 amount;
        bytes32 withdrawalId;
        uint64 epoch;
    }

    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(uint256 chainId,address gateway,address token,address recipient,uint256 amount,bytes32 withdrawalId,uint64 epoch)"
    );

    struct TokenConfig {
        bool allowed;
        /// Largest single withdrawal, in the token's base units.
        uint256 maxWithdrawal;
    }

    mapping(address => TokenConfig) public tokens;

    /// Signer set epoch. Every attestation names the epoch it was made for and
    /// only the current epoch is accepted, so a certificate signed by a
    /// rotated-out committee is dead the moment the rotation lands.
    uint64 public epoch;
    uint256 public threshold;
    mapping(uint64 => mapping(address => bool)) public isSigner;
    address[] private _signers;

    mapping(bytes32 => bool) public consumed;
    uint256 public depositCount;

    event Deposit(uint256 indexed id, address indexed token, address indexed from, uint256 amount, bytes32 receipt);
    event Withdrawn(bytes32 indexed withdrawalId, address indexed token, address indexed recipient, uint256 amount, uint64 epoch);
    event SignersRotated(uint64 indexed epoch, address[] signers, uint256 threshold);
    event TokenConfigured(address indexed token, bool allowed, uint256 maxWithdrawal);

    error TokenNotAllowed(address token);
    error ZeroAmount();
    error InexactTransfer(uint256 expected, uint256 received);
    error WrongChain(uint256 expected, uint256 got);
    error WrongGateway(address expected, address got);
    error StaleEpoch(uint64 current, uint64 got);
    error AlreadyConsumed(bytes32 withdrawalId);
    error AboveCap(uint256 cap, uint256 amount);
    error NotEnoughSignatures(uint256 needed, uint256 valid);
    error SignersNotSorted();
    error NotASigner(address signer);
    error BadSignerSet();
    error ZeroRecipient();

    constructor(address owner_, address[] memory signers_, uint256 threshold_)
        Ownable(owner_)
        EIP712("PealLinksGateway", "1")
    {
        _rotate(signers_, threshold_);
    }

    // ---- deposits -----------------------------------------------------------

    /// @notice Deposit `amount` of `token` for the private receipt `receipt`
    /// (a commitment the depositor computed and registered with the ledger
    /// beforehand). The gateway learns the amount and the sender, never which
    /// private account the receipt belongs to.
    function deposit(address token, uint256 amount, bytes32 receipt) external nonReentrant whenNotPaused returns (uint256 id) {
        if (!tokens[token].allowed) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        // Balance difference, so a fee-on-transfer or rebasing token cannot
        // credit more than actually arrived: the deposit is refused outright
        // rather than credited for less.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert InexactTransfer(amount, received);
        id = ++depositCount;
        emit Deposit(id, token, msg.sender, amount, receipt);
    }

    // ---- withdrawals --------------------------------------------------------

    /// @notice The EIP-712 digest signers attest to.
    function withdrawalDigest(Withdrawal calldata w) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.chainId, w.gateway, w.token, w.recipient, w.amount, w.withdrawalId, w.epoch))
        );
    }

    /// @notice Release `w.amount` of `w.token` to `w.recipient` once. Anyone
    /// may submit; `signatures` must come from distinct current-epoch
    /// signers, sorted by ascending signer address, at least `threshold` of
    /// them.
    function withdraw(Withdrawal calldata w, bytes[] calldata signatures) external nonReentrant whenNotPaused {
        if (w.chainId != block.chainid) revert WrongChain(block.chainid, w.chainId);
        if (w.gateway != address(this)) revert WrongGateway(address(this), w.gateway);
        if (w.epoch != epoch) revert StaleEpoch(epoch, w.epoch);
        if (w.recipient == address(0)) revert ZeroRecipient();
        if (w.amount == 0) revert ZeroAmount();
        TokenConfig memory cfg = tokens[w.token];
        if (!cfg.allowed) revert TokenNotAllowed(w.token);
        if (w.amount > cfg.maxWithdrawal) revert AboveCap(cfg.maxWithdrawal, w.amount);
        if (consumed[w.withdrawalId]) revert AlreadyConsumed(w.withdrawalId);

        bytes32 digest = withdrawalDigest(w);
        address last = address(0);
        uint256 valid = 0;
        for (uint256 i = 0; i < signatures.length; i++) {
            // `recover` reverts on malformed or high-s signatures.
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!isSigner[epoch][signer]) revert NotASigner(signer);
            last = signer;
            valid++;
        }
        if (valid < threshold) revert NotEnoughSignatures(threshold, valid);

        consumed[w.withdrawalId] = true;
        IERC20(w.token).safeTransfer(w.recipient, w.amount);
        emit Withdrawn(w.withdrawalId, w.token, w.recipient, w.amount, w.epoch);
    }

    // ---- administration -----------------------------------------------------

    /// @notice Replace the signer set. Starts a new epoch; attestations for
    /// the old epoch stop verifying immediately.
    function rotateSigners(address[] calldata signers_, uint256 threshold_) external onlyOwner {
        _rotate(signers_, threshold_);
    }

    function _rotate(address[] memory signers_, uint256 threshold_) internal {
        if (signers_.length == 0 || threshold_ == 0 || threshold_ > signers_.length) revert BadSignerSet();
        epoch += 1;
        delete _signers;
        for (uint256 i = 0; i < signers_.length; i++) {
            address s = signers_[i];
            if (s == address(0) || isSigner[epoch][s]) revert BadSignerSet();
            isSigner[epoch][s] = true;
            _signers.push(s);
        }
        threshold = threshold_;
        emit SignersRotated(epoch, signers_, threshold_);
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    function configureToken(address token, bool allowed, uint256 maxWithdrawal) external onlyOwner {
        tokens[token] = TokenConfig({allowed: allowed, maxWithdrawal: maxWithdrawal});
        emit TokenConfigured(token, allowed, maxWithdrawal);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20Permit} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Initializable} from "openzeppelin-contracts/contracts/proxy/utils/Initializable.sol";

import {ClearingPrice} from "./ClearingPrice.sol";
import {AuctionMath} from "./AuctionMath.sol";
import {CommitteeRegistry} from "./CommitteeRegistry.sol";

/// @title SealedBidAuction
/// @notice One sealed-bid, uniform-price auction. Non-upgradeable clone with
/// snapshotted configuration.
///
/// ## Why the reveal works the way it does
///
/// Peal's threshold decryption is publicly verifiable — `verify_share` is a
/// BLS12-381 pairing check. EIP-2537 makes that curve available on the EVM, but
/// the check is a multi-pairing whose term count scales with the batch size, and
/// this repository has not benchmarked it. Until it has, the contract does not
/// verify the decryption itself. See docs/auctionkit/decisions/0001-reveal-root.md.
///
/// Instead the snapshotted committee signs an EIP-712 message over a merkle root
/// of the canonical revealed-bid list, and this contract requires `threshold`
/// unique signatures from members of the set that was snapshotted **at auction
/// creation**. See docs/auctionkit/trust-assumptions.md §3 for exactly what that
/// does and does not buy.
///
/// The property that survives: a malicious committee cannot substitute a
/// different plaintext for a bid, because every revealed bid is checked against
/// the salted commitment its bidder posted onchain before the close. It can only
/// *omit* bids — and omission is caught by requiring
/// `processedBidCount == committedBidCount` before settlement, so an omitted bid
/// halts the auction into refunds rather than silently moving the price.
///
/// Censorship becomes a liveness failure with a permissionless refund path.
/// That is the correct direction for a failure to point.
contract SealedBidAuction is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum State {
        Created,
        Funded,
        CommitOpen,
        CommitClosed,
        RevealPending,
        Revealing,
        ReadyToSettle,
        Settled,
        Failed,
        Cancelled
    }

    struct Config {
        address issuer;
        address saleToken;
        address quoteToken;
        uint256 totalSupply;
        uint8 saleDecimals;
        uint8 quoteDecimals;
        uint256 reservePrice;
        uint256 tickSize;
        uint16 numTicks;
        uint64 startTime;
        uint64 endTime;
        uint64 revealDeadline;
        uint256 minBidQuantity;
        uint256 maxQuantityPerAddress;
        uint32 maxBids;
        bytes32 allowlistRoot;
        uint16 protocolFeeBps;
        address feeRecipient;
        bytes32 committeeSetId;
        bytes32 encryptionEpoch;
        bytes32 metadataHash;
        /// @notice How long settlement waits after a bid is voided, so a
        ///         bidder whose bid was wrongly voided can prove it.
        ///
        /// Chosen by the issuer rather than fixed, because the right value is a
        /// judgement about their own auction: an hour is sensible for a real
        /// sale, and a test that has to wait an hour to see a settlement is a
        /// test nobody runs.
        ///
        /// Zero is permitted and is a real weakening, not a formality. With no
        /// window the committee can void a bid and finalize in the same block,
        /// leaving the bidder no opportunity to dispute. Their escrow is still
        /// refundable, so this is censorship rather than theft, but an auction
        /// carrying value should not be run this way.
        uint64 voidDisputeWindow;
        uint16 version;
    }

    struct Bid {
        address bidder;
        bytes32 commitment;
        bytes32 ciphertextHash;
        uint256 escrow;
        uint64 blockNumber;
        bool revealed;
        bool claimed;
        /// @dev Attested by the committee but the plaintext does not match what
        ///      the bidder committed to. Excluded from demand, escrow fully
        ///      refundable through the normal `claim` path.
        bool voided;
        uint256 quantity;
        uint16 tick;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    Config public config;
    CommitteeRegistry public registry;
    State public state;

    uint32 public committedBidCount;
    uint32 public processedBidCount;
    /// @dev How many bids were attested but did not match their commitment.
    ///      Nonzero means settlement waits out `config.voidDisputeWindow`.
    uint32 public voidedBidCount;
    uint64 public lastVoidAt;
    bytes32 public revealRoot;
    uint64 public revealRootRegisteredAt;

    ClearingPrice.Result public clearing;
    uint256 public clearingPrice;
    uint256 public grossProceeds;
    uint256 public protocolFee;

    bool public issuerProceedsClaimed;
    bool public issuerUnsoldClaimed;

    mapping(uint32 => Bid) public bids;
    mapping(address => uint256) public quantityByAddress;
    mapping(uint16 => uint256) public demandByTick;

    /// @dev Batch references, for ciphertext availability auditing.
    bytes32[] public batchCommitments;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event AuctionCreated(address indexed issuer, bytes32 committeeSetId, uint16 version);
    event AuctionFunded(uint256 supply);
    event BidCommitted(
        uint32 indexed bidId, address indexed bidder, bytes32 commitment, bytes32 ciphertextHash, uint256 escrow
    );
    event BatchRegistered(uint256 indexed batchIndex, bytes32 batchCommitment);
    event CommitClosed(uint32 bidCount);
    event RevealRootRegistered(bytes32 indexed root, uint32 bidCount, uint256 signatures);
    event BidRevealed(uint32 indexed bidId, uint256 quantity, uint16 tick);
    /// @notice A bid whose revealed plaintext does not match its commitment.
    /// @dev Emitted rather than reverted. Anyone can check the claim: recompute
    ///      `bidCommitment` from the revealed values and compare it to the
    ///      commitment in `getBid`. A bidder who believes the committee
    ///      attested the wrong plaintext for them can publish their own
    ///      preimage, and the mismatch is then attributable to the signed root.
    event BidVoided(uint32 indexed bidId, address indexed bidder);
    /// @notice A voided bidder proved their commitment was well-formed. The
    ///         auction halts and everyone is refunded.
    event VoidDisputed(uint32 indexed bidId, address indexed bidder);
    event Finalized(uint16 clearingTick, uint256 clearingPrice, uint256 supplySold, uint256 proceeds, uint256 fee);
    event BidderClaimed(uint32 indexed bidId, address indexed bidder, uint256 tokens, uint256 refund);
    event IssuerProceedsClaimed(uint256 net, uint256 fee);
    event IssuerUnsoldClaimed(uint256 unsold);
    event AuctionFailed(string reason);
    event AuctionCancelled();

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error BadState(State actual, State expected);
    error NotIssuer();
    error TooEarly();
    error TooLate();
    error BadTick();
    error BadQuantity();
    error PerAddressCapExceeded();
    error TooManyBids();
    error AlreadyClaimed();
    error NotAllowlisted();
    error CommitmentMismatch();
    error AlreadyRevealed();
    error InsufficientSignatures(uint256 got, uint256 need);
    error NotCommitteeMember(address signer);
    error SignersNotSorted();
    error RevealIncomplete(uint32 processed, uint32 committed);
    error NothingToClaim();
    error FeeOnTransferToken();
    error RootAlreadyRegistered();

    // ---------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant REVEAL_ROOT_TYPEHASH = keccak256(
        "RevealRoot(address auction,uint256 chainId,bytes32 committeeSetId,bytes32 encryptionEpoch,bytes32 root,uint32 bidCount)"
    );

    /// @dev `bidId` is deliberately NOT in this struct. It used to be, and it
    ///      was a race: the contract assigns `bidId = committedBidCount` inside
    ///      `commitBid`, so a bidder could only bind it by reading the counter
    ///      first and hoping nobody landed in between. Two wallets in the same
    ///      block both read the same value and one of them committed to an id
    ///      that was never theirs.
    ///
    ///      Nothing is lost by removing it. `bidder` is bound here and
    ///      `bids[bidId].bidder` is what the reveal checks against, so a
    ///      commitment still cannot be moved to another account.
    bytes32 public constant BID_COMMITMENT_TYPEHASH = keccak256(
        "BidCommitment(uint256 chainId,address auction,address bidder,uint256 quantity,uint16 maxPriceTick,bytes32 salt,uint16 bidVersion)"
    );

    /// @notice The dispute window a sale carrying value should use.
    ///
    /// @dev Not enforced. `config.voidDisputeWindow` is what the contract
    ///      actually applies; this is the value an issuer should reach for
    ///      unless they have a reason not to, and what the interface offers by
    ///      default.
    uint64 public constant RECOMMENDED_VOID_DISPUTE_WINDOW = 1 hours;

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    constructor() {
        _disableInitializers();
    }

    function initialize(Config calldata cfg, address registry_) external initializer {
        require(cfg.issuer != address(0), "issuer");
        require(cfg.saleToken != address(0) && cfg.quoteToken != address(0), "tokens");
        require(cfg.saleToken != cfg.quoteToken, "same token");
        require(cfg.totalSupply > 0, "supply");
        require(cfg.numTicks > 0 && cfg.numTicks <= ClearingPrice.MAX_TICKS, "ticks");
        require(cfg.startTime < cfg.endTime, "schedule");
        // Reveals happen after the close, and a voided bidder needs the
        // dispute window inside that same period. Without room for both, a
        // griefer could post a junk bid, have it voided late, and leave no time
        // to finalize, which is the denial of service voiding exists to remove.
        //
        // The issuer picks the window, so this only checks the two are
        // consistent rather than imposing a duration.
        require(cfg.revealDeadline > cfg.endTime, "reveal window");
        require(cfg.revealDeadline >= cfg.endTime + cfg.voidDisputeWindow, "reveal window too short");
        require(cfg.protocolFeeBps <= 1_000, "fee too high"); // hard cap 10%
        require(cfg.feeRecipient != address(0) || cfg.protocolFeeBps == 0, "fee recipient");
        require(CommitteeRegistry(registry_).exists(cfg.committeeSetId), "committee");

        config = cfg;
        registry = CommitteeRegistry(registry_);
        state = State.Created;
        emit AuctionCreated(cfg.issuer, cfg.committeeSetId, cfg.version);
    }

    modifier onlyIssuer() {
        if (msg.sender != config.issuer) revert NotIssuer();
        _;
    }

    modifier inState(State expected) {
        if (state != expected) revert BadState(state, expected);
        _;
    }

    /// @notice Escrow the full sale supply. Must happen before bidding opens —
    /// a bidder must never be able to commit funds to an auction whose tokens
    /// are not already locked.
    /// @dev Deliberately NOT `onlyIssuer`. Funding only ever moves the full
    ///      supply *into* the auction, from whoever calls it, and the tokens are
    ///      then bound by the auction's own rules regardless of who sent them.
    ///      There is nothing an outside funder can gain and nothing a bidder can
    ///      lose by it.
    ///
    ///      Requiring the issuer would mean an auction could only be created and
    ///      funded in two separate transactions by the same key, which leaves a
    ///      window where an auction exists, looks live, and holds no supply. A
    ///      bidder finding it in that window would commit real escrow against
    ///      tokens that were never escrowed. `AuctionFactory` closes that window
    ///      by doing both in one call, and it can only do so because of this.
    ///
    ///      One consequence to know: `cancel` returns the supply to
    ///      `config.issuer`, not to whoever funded. Funding an auction you do
    ///      not control is therefore a gift to its issuer.
    function fund() external inState(State.Created) nonReentrant {
        IERC20 sale = IERC20(config.saleToken);
        uint256 before = sale.balanceOf(address(this));
        sale.safeTransferFrom(msg.sender, address(this), config.totalSupply);
        // Balance-delta check: a fee-on-transfer token would deliver less than
        // the auction promises to sell, which would strand the shortfall on the
        // last claimer. Reject rather than discover it at claim time.
        if (sale.balanceOf(address(this)) - before != config.totalSupply) revert FeeOnTransferToken();

        state = State.Funded;
        emit AuctionFunded(config.totalSupply);
    }

    /// @notice Open bidding. Anyone may call once the start time has passed;
    /// leaving it to the issuer would let them stall an auction they funded.
    function openCommit() external inState(State.Funded) {
        if (block.timestamp < config.startTime) revert TooEarly();
        state = State.CommitOpen;
    }

    /// @notice Cancel. Only before bidding opens, or after it opens if nobody
    /// bid — an issuer must not be able to walk away from live commitments.
    function cancel() external onlyIssuer nonReentrant {
        if (state == State.Created) {
            state = State.Cancelled;
            emit AuctionCancelled();
            return;
        }
        if (state == State.Funded || (state == State.CommitOpen && committedBidCount == 0)) {
            state = State.Cancelled;
            IERC20(config.saleToken).safeTransfer(config.issuer, config.totalSupply);
            emit AuctionCancelled();
            return;
        }
        revert BadState(state, State.Funded);
    }

    // ---------------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------------

    /// @notice Commit an encrypted bid.
    ///
    /// @param commitment  keccak256 over the EIP-712 BidCommitment struct. The
    ///                    contract cannot check it now — that is the point — but
    ///                    it binds the bidder so the reveal cannot substitute
    ///                    different parameters later.
    /// @param ciphertextHash  sha256 of the Peal ciphertext, registered onchain
    ///                    so ciphertext loss is provable and attributable.
    /// @param escrowAmount    quote tokens covering quantity x maxPrice. The
    ///                    contract cannot recompute this without the plaintext,
    ///                    so it is checked at reveal against the revealed bid.
    function commitBid(bytes32 commitment, bytes32 ciphertextHash, uint256 escrowAmount, bytes32[] calldata allowlistProof)
        external
        inState(State.CommitOpen)
        nonReentrant
        returns (uint32 bidId)
    {
        return _commitBid(commitment, ciphertextHash, escrowAmount, allowlistProof);
    }

    /// @notice Commit a bid and approve its escrow in a single transaction.
    ///
    /// Bidding used to cost two transactions and two wallet prompts: an
    /// `approve`, then a `commitBid`. On a twelve second chain that is most of
    /// the wait a bidder actually feels, and the second prompt is where people
    /// stop. With EIP-2612 the approval becomes an offchain signature, so this
    /// is one transaction and one prompt.
    ///
    /// @dev The permit is wrapped in try/catch on purpose. A permit signature
    ///      is public once broadcast, so anyone can submit it first, consume
    ///      the nonce, and leave the real transaction reverting on a permit
    ///      that has already been used. Swallowing that failure means the bid
    ///      still lands, because the allowance it needed now exists either way.
    ///      If no allowance exists the `safeTransferFrom` below reverts, which
    ///      is the correct and only failure.
    ///
    ///      Requires a quote token implementing EIP-2612. Tokens without it
    ///      still work through `commitBid`.
    function commitBidWithPermit(
        bytes32 commitment,
        bytes32 ciphertextHash,
        uint256 escrowAmount,
        bytes32[] calldata allowlistProof,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external inState(State.CommitOpen) nonReentrant returns (uint32 bidId) {
        try IERC20Permit(config.quoteToken).permit(msg.sender, address(this), escrowAmount, deadline, v, r, s) {}
        catch {}
        return _commitBid(commitment, ciphertextHash, escrowAmount, allowlistProof);
    }

    function _commitBid(
        bytes32 commitment,
        bytes32 ciphertextHash,
        uint256 escrowAmount,
        bytes32[] calldata allowlistProof
    ) private returns (uint32 bidId) {
        if (block.timestamp < config.startTime) revert TooEarly();
        if (block.timestamp >= config.endTime) revert TooLate();
        if (committedBidCount >= config.maxBids) revert TooManyBids();
        if (escrowAmount == 0) revert BadQuantity();
        if (commitment == bytes32(0) || ciphertextHash == bytes32(0)) revert CommitmentMismatch();

        if (config.allowlistRoot != bytes32(0)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
            if (!MerkleProof.verifyCalldata(allowlistProof, config.allowlistRoot, leaf)) revert NotAllowlisted();
        }

        IERC20 quote = IERC20(config.quoteToken);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), escrowAmount);
        if (quote.balanceOf(address(this)) - before != escrowAmount) revert FeeOnTransferToken();

        bidId = committedBidCount;
        bids[bidId] = Bid({
            bidder: msg.sender,
            commitment: commitment,
            ciphertextHash: ciphertextHash,
            escrow: escrowAmount,
            blockNumber: uint64(block.number),
            revealed: false,
            claimed: false,
            voided: false,
            quantity: 0,
            tick: 0
        });
        committedBidCount = bidId + 1;

        emit BidCommitted(bidId, msg.sender, commitment, ciphertextHash, escrowAmount);
    }

    /// @notice Record a Peal batch commitment for availability auditing.
    /// @dev Informational: the settlement path does not depend on it. It exists
    ///      so a receipt can point at which batches held which ciphertexts.
    function registerBatch(bytes32 batchCommitment) external inState(State.CommitOpen) {
        batchCommitments.push(batchCommitment);
        emit BatchRegistered(batchCommitments.length - 1, batchCommitment);
    }

    /// @notice Close bidding. Permissionless once the end time has passed.
    function closeCommit() external inState(State.CommitOpen) {
        if (block.timestamp < config.endTime) revert TooEarly();
        state = committedBidCount == 0 ? State.Failed : State.CommitClosed;
        if (state == State.Failed) emit AuctionFailed("no bids");
        else emit CommitClosed(committedBidCount);
    }

    // ---------------------------------------------------------------------
    // Reveal
    // ---------------------------------------------------------------------

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("PealAuctionKit"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function revealRootDigest(bytes32 root, uint32 bidCount) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                REVEAL_ROOT_TYPEHASH,
                address(this),
                block.chainid,
                config.committeeSetId,
                config.encryptionEpoch,
                root,
                bidCount
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Register the committee-attested reveal root.
    ///
    /// @param signatures  must be ordered by ascending recovered signer address.
    ///                    Sorting is how uniqueness is enforced in O(n) without
    ///                    a nested loop or scratch storage — a duplicate signer
    ///                    cannot appear in a strictly ascending sequence, so one
    ///                    operator cannot sign twice to fake the threshold.
    function registerRevealRoot(bytes32 root, uint32 bidCount, bytes[] calldata signatures)
        external
        inState(State.CommitClosed)
    {
        if (block.timestamp >= config.revealDeadline) revert TooLate();
        if (revealRoot != bytes32(0)) revert RootAlreadyRegistered();
        // The root must cover exactly the bids that were committed. A root for
        // a different count is either an omission or an injection.
        if (bidCount != committedBidCount) revert RevealIncomplete(bidCount, committedBidCount);

        uint16 threshold = registry.thresholdOf(config.committeeSetId);
        if (signatures.length < threshold) revert InsufficientSignatures(signatures.length, threshold);

        bytes32 digest = revealRootDigest(root, bidCount);
        address last = address(0);
        for (uint256 i = 0; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!registry.isMember(config.committeeSetId, signer)) revert NotCommitteeMember(signer);
            last = signer;
        }

        revealRoot = root;
        revealRootRegisteredAt = uint64(block.timestamp);
        state = State.Revealing;
        emit RevealRootRegistered(root, bidCount, signatures.length);
    }

    /// @notice Leaf of the reveal tree for one bid.
    /// @dev Double-hashed, the standard defence against a leaf being reinterpreted
    ///      as an internal node.
    function revealLeaf(uint32 bidId, uint256 quantity, uint16 tick, bytes32 salt) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(bidId, quantity, tick, salt))));
    }

    /// @notice Compute the commitment a bidder should have posted.
    /// @dev Computable by the bidder before submitting, which is the whole
    ///      point: it depends only on values they already hold.
    function bidCommitment(address bidder, uint256 quantity, uint16 maxPriceTick, bytes32 salt, uint16 bidVersion)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                BID_COMMITMENT_TYPEHASH, block.chainid, address(this), bidder, quantity, maxPriceTick, salt, bidVersion
            )
        );
    }

    /// @notice Process revealed bids in bounded chunks.
    ///
    /// @dev Two independent checks, and both matter:
    ///
    ///      1. The merkle proof binds this entry to the committee-attested root.
    ///      2. The salted commitment binds it to what the *bidder* posted before
    ///         the close.
    ///
    ///      (2) is what stops a colluding committee from swapping a bid's
    ///      plaintext: they would have to find a preimage for a commitment that
    ///      already exists onchain.
    /// @notice One revealed bid, as attested by the committee.
    /// @dev A struct rather than six parallel arrays: parallel arrays need a
    ///      length check per array, put six stack slots in play per iteration
    ///      (which overflows the stack), and let a caller silently mis-align
    ///      one of them.
    struct RevealEntry {
        uint32 bidId;
        uint256 quantity;
        uint16 tick;
        bytes32 salt;
        uint16 bidVersion;
        bytes32[] proof;
    }

    /// @notice Process revealed bids in bounded chunks.
    ///
    /// @dev Two independent checks, and both matter:
    ///
    ///      1. The merkle proof binds this entry to the committee-attested root.
    ///      2. The salted commitment binds it to what the *bidder* posted before
    ///         the close.
    ///
    ///      (2) is what stops a colluding committee from swapping a bid's
    ///      plaintext: they would have to find a preimage for a commitment that
    ///      already exists onchain.
    function processReveals(RevealEntry[] calldata entries) external inState(State.Revealing) {
        for (uint256 i = 0; i < entries.length; ++i) {
            _processOne(entries[i]);
        }
    }

    function _processOne(RevealEntry calldata e) private {
        Bid storage b = bids[e.bidId];
        if (b.bidder == address(0)) revert CommitmentMismatch();
        if (b.revealed) revert AlreadyRevealed();
        if (e.tick >= config.numTicks) revert BadTick();

        // The proof is non-negotiable: it is what proves the committee actually
        // attested something for this bid. Without it a caller could invent
        // reveals, so a bad proof is a malformed call and still reverts.
        if (!MerkleProof.verifyCalldata(e.proof, revealRoot, revealLeaf(e.bidId, e.quantity, e.tick, e.salt))) {
            revert CommitmentMismatch();
        }

        b.revealed = true;
        processedBidCount += 1;

        // A commitment mismatch is the BIDDER's problem, not the auction's.
        //
        // This used to revert, and that turned one bad bid into a dead auction:
        // `finalize` requires every committed bid to be processed, so a bid
        // that could never be processed meant the auction could never settle.
        // Since `commitBid` cannot inspect a commitment - that is what makes a
        // bid sealed - anyone could post `keccak256("junk")` with one wei of
        // escrow and permanently halt any auction for the price of gas.
        //
        // Voiding instead of reverting removes that. The bid contributes no
        // demand and its escrow is fully refundable through `claim`.
        if (bidCommitment(b.bidder, e.quantity, e.tick, e.salt, e.bidVersion) != b.commitment) {
            b.voided = true;
            voidedBidCount += 1;
            lastVoidAt = uint64(block.timestamp);
            emit BidVoided(e.bidId, b.bidder);
            return;
        }

        b.quantity = e.quantity;
        b.tick = e.tick;

        // Only bids that are actually eligible contribute demand. An undersized
        // bid, or one whose escrow does not cover its own maximum, is revealed
        // but excluded — its escrow is fully refunded.
        if (_isEligible(b, e.quantity, e.tick)) {
            demandByTick[e.tick] += e.quantity;
        }

        emit BidRevealed(e.bidId, e.quantity, e.tick);
    }

    /// @dev Eligibility is checked at reveal, not at commit, because at commit
    ///      the contract cannot see the quantity. A bid whose escrow is short of
    ///      its own stated maximum is excluded rather than reverted: reverting
    ///      would let one malformed bid block the whole auction.
    function _isEligible(Bid storage b, uint256 qty, uint16 tick) private view returns (bool) {
        if (qty < config.minBidQuantity) return false;
        if (config.maxQuantityPerAddress != 0 && qty > config.maxQuantityPerAddress) return false;
        uint256 required =
            AuctionMath.escrowFor(qty, config.reservePrice, config.tickSize, tick, config.saleDecimals);
        return b.escrow >= required;
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Prove that a voided bid was in fact well-formed, and halt.
    ///
    /// Voiding a mismatched bid is what stops one junk commitment from killing
    /// an auction. On its own, though, it would hand the committee a censorship
    /// button: attest the wrong plaintext for a bidder you dislike and they are
    /// quietly dropped while the auction settles without them.
    ///
    /// This closes that. The contract cannot tell a junk commitment from a
    /// substituted plaintext - both are just a mismatch - but the *bidder* can,
    /// because only they hold a preimage that matches what they posted.
    /// Producing one proves the commitment was well-formed, which proves the
    /// attested leaf was not theirs.
    ///
    /// The response is a halt, not a correction: a committee that attested one
    /// wrong leaf has no claim to be trusted on the others. Everyone is
    /// refunded through the normal `claim` path, and the signed root makes the
    /// misbehaviour attributable afterwards.
    ///
    /// A griefer cannot use this. They have no preimage for a commitment they
    /// made up, which is exactly why their bid was voided.
    ///
    /// Permissionless: the evidence stands on its own, whoever carries it.
    function disputeVoid(uint32 bidId, uint256 quantity, uint16 tick, bytes32 salt, uint16 bidVersion)
        external
        inState(State.Revealing)
    {
        Bid storage b = bids[bidId];
        if (!b.voided) revert NothingToClaim();
        if (bidCommitment(b.bidder, quantity, tick, salt, bidVersion) != b.commitment) {
            revert CommitmentMismatch();
        }

        state = State.Failed;
        emit VoidDisputed(bidId, b.bidder);
        emit AuctionFailed("committee attested a plaintext the bidder never committed to");
    }

    /// @notice Compute the clearing price. Permissionless.
    function finalize() external inState(State.Revealing) {
        // If anything was voided, settlement waits so a wronged bidder can
        // produce their preimage first. Without this the committee could void a
        // bid and finalize in the same block, leaving no window to dispute.
        if (voidedBidCount > 0 && block.timestamp < lastVoidAt + config.voidDisputeWindow) {
            revert TooEarly();
        }
        // Every committed bid must be accounted for. This is what turns
        // committee omission into a halt rather than a silent price change.
        if (processedBidCount != committedBidCount) revert RevealIncomplete(processedBidCount, committedBidCount);

        uint256[] memory demand = new uint256[](config.numTicks);
        for (uint16 t = 0; t < config.numTicks; ++t) {
            demand[t] = demandByTick[t];
        }

        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(demand, config.totalSupply);
        if (!r.cleared) {
            state = State.Failed;
            emit AuctionFailed("no eligible demand");
            return;
        }

        clearing = r;
        clearingPrice = AuctionMath.priceAt(config.reservePrice, config.tickSize, r.clearingTick);
        state = State.ReadyToSettle;

        // Proceeds are accrued from actual allocations at claim time; the
        // headline figure here is the sale at the clearing price.
        grossProceeds = AuctionMath.costFloor(r.supplySold, clearingPrice, config.saleDecimals);
        protocolFee = AuctionMath.feeOn(grossProceeds, config.protocolFeeBps);

        state = State.Settled;
        emit Finalized(r.clearingTick, clearingPrice, r.supplySold, grossProceeds, protocolFee);
    }

    /// @notice Permissionless failure trigger once the reveal deadline passes.
    /// @dev The objective recovery path. No administrator is involved, and no
    ///      administrator can prevent it.
    function failOnRevealTimeout() external {
        if (block.timestamp < config.revealDeadline) revert TooEarly();
        if (state != State.CommitClosed && state != State.Revealing) revert BadState(state, State.Revealing);
        state = State.Failed;
        emit AuctionFailed("reveal deadline passed");
    }

    // ---------------------------------------------------------------------
    // Claims — pull based, never a loop over bidders
    // ---------------------------------------------------------------------

    function allocationOf(uint32 bidId) public view returns (uint256) {
        Bid storage b = bids[bidId];
        if (state != State.Settled || !b.revealed || b.voided) return 0;
        if (!_isEligible(b, b.quantity, b.tick)) return 0;
        return ClearingPrice.allocationFor(clearing, b.quantity, b.tick);
    }

    /// @notice Claim tokens and any refund. Safe in every terminal state.
    function claim(uint32 bidId) external nonReentrant returns (uint256 tokens, uint256 refund) {
        Bid storage b = bids[bidId];
        if (b.bidder == address(0)) revert NothingToClaim();
        if (b.claimed) revert AlreadyClaimed();
        if (state != State.Settled && state != State.Failed && state != State.Cancelled) {
            revert BadState(state, State.Settled);
        }

        b.claimed = true; // effects before interactions

        if (state == State.Settled) {
            tokens = allocationOf(bidId);
            uint256 paid = AuctionMath.costFloor(tokens, clearingPrice, config.saleDecimals);
            refund = b.escrow - paid;
        } else {
            // Failed or cancelled: full refund, no allocation.
            refund = b.escrow;
        }

        if (tokens > 0) IERC20(config.saleToken).safeTransfer(b.bidder, tokens);
        if (refund > 0) IERC20(config.quoteToken).safeTransfer(b.bidder, refund);

        emit BidderClaimed(bidId, b.bidder, tokens, refund);
    }

    /// @notice Issuer takes the proceeds, net of fee. Only after settlement.
    function claimProceeds() external onlyIssuer inState(State.Settled) nonReentrant {
        if (issuerProceedsClaimed) revert AlreadyClaimed();
        issuerProceedsClaimed = true;

        uint256 fee = protocolFee;
        uint256 net = grossProceeds - fee;

        if (fee > 0) IERC20(config.quoteToken).safeTransfer(config.feeRecipient, fee);
        if (net > 0) IERC20(config.quoteToken).safeTransfer(config.issuer, net);
        emit IssuerProceedsClaimed(net, fee);
    }

    /// @notice Issuer recovers unsold supply, including pro-rata rounding dust.
    function claimUnsold() external onlyIssuer nonReentrant {
        if (state != State.Settled && state != State.Failed) revert BadState(state, State.Settled);
        if (issuerUnsoldClaimed) revert AlreadyClaimed();
        issuerUnsoldClaimed = true;

        uint256 sold = state == State.Settled ? clearing.supplySold : 0;
        uint256 unsold = config.totalSupply - sold;
        if (unsold > 0) IERC20(config.saleToken).safeTransfer(config.issuer, unsold);
        emit IssuerUnsoldClaimed(unsold);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getConfig() external view returns (Config memory) {
        return config;
    }

    function getBid(uint32 bidId) external view returns (Bid memory) {
        return bids[bidId];
    }

    function batchCount() external view returns (uint256) {
        return batchCommitments.length;
    }

    function configHash() external view returns (bytes32) {
        return keccak256(abi.encode(config));
    }
}

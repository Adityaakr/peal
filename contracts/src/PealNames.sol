// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title PealNames
/// @notice Short, memorable links for Peal auctions: `peal.network/shoonya`
///         instead of a hundred and sixty characters of base64.
///
/// @dev WHY A CONTRACT AND NOT A SERVER.
///
/// A Peal Live link carries the whole auction in its URL fragment, which never
/// reaches any server, so today nobody can change what an auction's terms are.
/// A short name breaks that on its own: something has to answer "what is
/// `shoonya`", and whoever answers can answer differently to different people.
///
/// Putting the answer on chain keeps the property. The registry is the chain,
/// the mapping is public, and the rule below is enforced by code rather than by
/// whoever is running a database that day.
///
/// THE RULE: a name is claimed once and never moves.
///
/// This is the whole security argument, and it costs real convenience: a
/// streamer cannot reuse their handle for next week's auction, and a good name
/// spent on a test is spent. That is the trade being made on purpose. A name
/// that can be repointed means the person who shared a link is also the person
/// who can change where it goes, and a viewer who saved `peal.network/shoonya`
/// during one auction could open a different one later without anything looking
/// wrong. There is no way to have both.
///
/// The terms blob is stored rather than a hash of it, because a hash cannot be
/// resolved back into an auction. Reading it is an `eth_call`, so a browser
/// needs no key, no backend and no library beyond a `fetch`.
contract PealNames {
    /// @notice The longest terms blob a name may carry.
    /// @dev Peal Live terms are a base64url tuple of an id, a title of at most
    /// eighty characters, a unit, two numbers and a reserve, which lands well
    /// under this. The cap exists so one claim cannot write unbounded storage.
    uint256 public constant MAX_TERMS_BYTES = 512;

    uint256 public constant MIN_NAME_BYTES = 3;
    uint256 public constant MAX_NAME_BYTES = 32;

    struct Record {
        address claimedBy;
        uint64 claimedAt;
        bytes terms;
    }

    /// @dev Keyed by the name's bytes rather than the string, so a lookup is one
    /// slot and callers can compute the key without a round trip.
    mapping(bytes32 => Record) private _records;

    /// @notice A name was taken. `name` is in the log rather than storage so the
    /// full set is enumerable off chain without knowing what to look for.
    event Claimed(bytes32 indexed nameHash, string name, address indexed claimedBy, bytes terms);

    error NameTaken(string name);
    error NameWrongLength();
    error NameHasInvalidCharacter(uint256 index);
    error NameEdgeHyphen();
    error TermsEmpty();
    error TermsTooLong();

    /// @notice Claim `name` for `terms`, forever.
    /// @param name Lowercase a-z, 0-9 and hyphens, 3 to 32 characters, not
    ///        starting or ending with a hyphen.
    /// @param terms The packed auction terms the name resolves to.
    function claim(string calldata name, bytes calldata terms) external {
        _requireValidName(name);
        if (terms.length == 0) revert TermsEmpty();
        if (terms.length > MAX_TERMS_BYTES) revert TermsTooLong();

        bytes32 key = nameHash(name);
        if (_records[key].claimedBy != address(0)) revert NameTaken(name);

        _records[key] = Record({
            claimedBy: msg.sender,
            claimedAt: uint64(block.timestamp),
            terms: terms
        });
        emit Claimed(key, name, msg.sender, terms);
    }

    /// @notice The terms a name resolves to, or empty bytes if it is unclaimed.
    /// @dev Returns empty rather than reverting: "no such name" is an ordinary
    /// answer for a browser resolving a link somebody typed, not a failure.
    function resolve(string calldata name) external view returns (bytes memory) {
        return _records[nameHash(name)].terms;
    }

    /// @notice Who claimed a name and when. Zero address means unclaimed.
    function ownerOf(string calldata name) external view returns (address claimedBy, uint64 claimedAt) {
        Record storage r = _records[nameHash(name)];
        return (r.claimedBy, r.claimedAt);
    }

    function isTaken(string calldata name) external view returns (bool) {
        return _records[nameHash(name)].claimedBy != address(0);
    }

    /// @notice The storage key for a name. Exposed so a client can precompute it.
    /// @dev No normalisation happens here. Case folding a UTF-8 string on chain
    /// would be a lot of gas to make `Shoonya` and `shoonya` the same name, and
    /// getting it subtly wrong would let two names collide. `claim` instead
    /// refuses anything that is not already lowercase, so the caller normalises
    /// and the contract enforces that they did.
    function nameHash(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function _requireValidName(string calldata name) private pure {
        bytes calldata b = bytes(name);
        if (b.length < MIN_NAME_BYTES || b.length > MAX_NAME_BYTES) revert NameWrongLength();
        // A hyphen at either end reads as a typo and makes two names that look
        // identical in a chat message resolve differently.
        if (b[0] == 0x2d || b[b.length - 1] == 0x2d) revert NameEdgeHyphen();

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) // a-z
                || (c >= 0x30 && c <= 0x39) // 0-9
                || c == 0x2d; // -
            if (!ok) revert NameHasInvalidCharacter(i);
        }
    }
}

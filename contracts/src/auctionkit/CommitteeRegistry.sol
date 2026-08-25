// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title CommitteeRegistry
/// @notice Committee sets, addressed by content so they cannot be edited.
///
/// A committee set is identified by `keccak256(abi.encode(threshold, members))`.
/// That is deliberate rather than a sequential id: there is no `updateSet`, so a
/// registered set is immutable, and an auction that snapshots a set id can never
/// have its committee changed underneath it. Rotating operators means
/// registering a *new* set with a new id; auctions already in flight keep the one
/// they started with.
///
/// This is the property that stops a committee change from retroactively
/// altering an active auction — the case where an operator who was not trusted
/// at bid time could otherwise become able to sign the reveal.
///
/// The registry holds only the EVM addresses that sign reveal roots. It does not
/// hold, and must never hold, any threshold decryption key material: those
/// shares live in operator keystores and never touch a chain.
contract CommitteeRegistry {
    struct CommitteeSet {
        uint16 threshold;
        address[] members;
        uint64 registeredAt;
    }

    mapping(bytes32 => CommitteeSet) private _sets;
    /// @dev Flattened for O(1) membership checks during signature verification.
    mapping(bytes32 => mapping(address => bool)) private _isMember;

    event CommitteeSetRegistered(bytes32 indexed setId, uint16 threshold, uint256 memberCount);

    error InvalidThreshold();
    error DuplicateMember(address member);
    error ZeroMember();
    error UnknownSet(bytes32 setId);

    /// @notice Register a committee set. Permissionless and idempotent: the id
    /// is derived from the content, so registering the same set twice is a
    /// no-op rather than a conflict.
    function registerCommitteeSet(uint16 threshold, address[] calldata members) external returns (bytes32 setId) {
        // A threshold above the member count can never be met — the set would
        // be dead on arrival, and every auction using it would fail to refunds.
        if (threshold == 0 || threshold > members.length) revert InvalidThreshold();

        setId = computeSetId(threshold, members);
        if (_sets[setId].threshold != 0) return setId; // already registered

        for (uint256 i = 0; i < members.length; ++i) {
            address m = members[i];
            if (m == address(0)) revert ZeroMember();
            // Duplicates would let one operator satisfy the threshold alone by
            // signing once and being counted twice.
            if (_isMember[setId][m]) revert DuplicateMember(m);
            _isMember[setId][m] = true;
        }

        _sets[setId] = CommitteeSet({threshold: threshold, members: members, registeredAt: uint64(block.timestamp)});
        emit CommitteeSetRegistered(setId, threshold, members.length);
    }

    function computeSetId(uint16 threshold, address[] calldata members) public pure returns (bytes32) {
        return keccak256(abi.encode(threshold, members));
    }

    function getCommitteeSet(bytes32 setId) external view returns (CommitteeSet memory) {
        CommitteeSet memory s = _sets[setId];
        if (s.threshold == 0) revert UnknownSet(setId);
        return s;
    }

    function thresholdOf(bytes32 setId) external view returns (uint16) {
        return _sets[setId].threshold;
    }

    function isMember(bytes32 setId, address who) external view returns (bool) {
        return _isMember[setId][who];
    }

    function exists(bytes32 setId) external view returns (bool) {
        return _sets[setId].threshold != 0;
    }
}

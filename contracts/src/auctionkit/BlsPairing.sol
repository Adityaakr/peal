// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title BlsPairing
/// @notice Thin wrapper over the EIP-2537 BLS12-381 pairing-check precompile.
///
/// Exists to answer one architectural question with a measurement rather than
/// an estimate: can a Peal threshold decryption share be verified onchain, and
/// at what gas?
///
/// Peal's share check is
///
///     e(pd_j, g_2) == prod_i e(ct_{i,0}, v_j^i)
///
/// which rearranges into the single product form the precompile accepts:
///
///     e(pd_j, -g_2) * prod_i e(ct_{i,0}, v_j^i) == 1
///
/// so a batch of size B costs `1 + B` pairing terms per share. That term count
/// is the whole story: the precompile's gas is a linear function of it, and the
/// calldata to carry it is 384 bytes per term.
///
/// If this fits, a valid share *is* an attestation, and the committee signing
/// key — along with its rotation and equivocation risk — can be deleted from
/// AuctionKit entirely. That is why this is measured before the signature layer
/// is hardened rather than after.
///
/// ## What this does NOT do
///
/// Verifying a share is not decrypting one. Recovering plaintexts still needs
/// an FFT and FO decryption, neither of which is going onchain. Onchain
/// verification removes the trust assumption about *who attests* to a share
/// being valid. It does not remove the committee.
library BlsPairing {
    /// @dev EIP-2537 `BLS12_PAIRING_CHECK`.
    address internal constant PAIRING = address(0x0f);

    /// @dev One term is a G1 point (128 bytes) followed by a G2 point (256).
    uint256 internal constant TERM_BYTES = 384;

    error MalformedInput();
    error PrecompileUnavailable();

    /// @notice `prod_k e(a_k, b_k) == 1` over `input`, which must be `k`
    ///         concatenated 384-byte terms.
    /// @dev Reverts rather than returning false when the precompile is absent,
    ///      because a missing precompile returns empty calldata, and treating
    ///      that as "the pairing did not hold" would silently downgrade a chain
    ///      without EIP-2537 into one that rejects every valid share.
    function check(bytes memory input) internal view returns (bool) {
        if (input.length == 0 || input.length % TERM_BYTES != 0) revert MalformedInput();

        (bool ok, bytes memory out) = PAIRING.staticcall(input);
        // The precompile reverts on malformed points, so `!ok` is a bad input.
        if (!ok) revert MalformedInput();
        if (out.length != 32) revert PrecompileUnavailable();

        return abi.decode(out, (uint256)) == 1;
    }

    /// @notice Terms in `input`.
    function termCount(bytes memory input) internal pure returns (uint256) {
        return input.length / TERM_BYTES;
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BlsPairing} from "../../src/auctionkit/BlsPairing.sol";
import {BlsPairingHarness} from "../../src/auctionkit/BlsPairingHarness.sol";

/// @notice Is onchain Peal share verification affordable on the target chain?
///
/// Run against a real fork, because the EIP-2537 precompiles do not exist in a
/// bare EVM and a local run would measure nothing:
///
///     forge test --match-contract BlsPairingGas --fork-url https://sepolia.base.org -vv
///
/// Gas for `BLS12_PAIRING_CHECK` is a function of the term count alone, not of
/// the point values, so infinity points give a truthful gas figure while
/// keeping the fixtures readable. `realPairingHolds` separately proves the
/// harness verifies an actual non-trivial relation.
contract BlsPairingGasTest is Test {
    BlsPairingHarness harness;

    /// Peal's share equation costs `1 + B` terms per share.
    uint256 constant B = 64;
    uint256 constant THRESHOLD = 3;

    /// e(P,Q) * e(-P,Q) == 1, where P and Q are the G1 and G2 generators.
    bytes constant PAIR_HOLDS =
        hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e100000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801000000000000000000000000000000000606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb00000000000000000000000000000000114d1d6855d545a8aa7d76c8cf2e21f267816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801000000000000000000000000000000000606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be";
    /// e(P,Q), which is not 1.
    bytes constant PAIR_FAILS =
        hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e100000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801000000000000000000000000000000000606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be";

    function setUp() public {
        harness = new BlsPairingHarness();
    }

    function _terms(uint256 k) internal pure returns (bytes memory out) {
        out = new bytes(k * 384);
    }

    function _skipUnlessAvailable() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(0x0f).staticcall(_terms(1));
        if (!ok || ret.length != 32) {
            console.log("EIP-2537 not present on this chain - skipping");
            return false;
        }
        return true;
    }

    /// The gas curve. This is the number the architecture decision turns on.
    function test_gasCurveAcrossTermCounts() public view {
        if (!_skipUnlessAvailable()) return;

        uint256[6] memory ks = [uint256(1), 2, 9, 17, 33, B + 1];
        uint256 prev;
        uint256 prevK;

        for (uint256 i = 0; i < ks.length; ++i) {
            uint256 k = ks[i];
            (uint256 used, bool ok) = harness.checkGas(_terms(k));
            assertTrue(ok, "infinity product should be 1");

            console.log("terms", k);
            console.log("  pairing gas", used);
            console.log("  calldata bytes", k * 384);

            if (prev != 0) {
                // Cost must be linear in the term count, or the scaling story
                // for larger batches is wrong.
                uint256 perTerm = (used - prev) / (k - prevK);
                console.log("  marginal gas/term", perTerm);
            }
            prev = used;
            prevK = k;
        }
    }

    /// The figure that actually matters: a whole reveal, `THRESHOLD` shares of
    /// `1 + B` terms each.
    function test_fullRevealBudget() public view {
        if (!_skipUnlessAvailable()) return;

        (uint256 perShare,) = harness.checkGas(_terms(B + 1));
        uint256 total = perShare * THRESHOLD;

        console.log("batch size B", B);
        console.log("threshold", THRESHOLD);
        console.log("gas per share", perShare);
        console.log("gas per reveal", total);
        console.log("calldata bytes per reveal", (B + 1) * 384 * THRESHOLD);

        // Not an assertion about affordability - just a tripwire so that a
        // change making this an order of magnitude worse fails loudly.
        assertLt(total, 30_000_000, "reveal no longer fits a generous block");
    }

    /// On an L2 the precompile gas is often not the binding cost - posting the
    /// terms to L1 is. 384 bytes per term of essentially incompressible field
    /// elements is a lot of data availability, so measure it rather than assume
    /// either way.
    ///
    /// Reads the OP-Stack `GasPriceOracle` predeploy, so this only means
    /// anything on an OP-Stack fork.
    function test_l1DataFeeForAReveal() public view {
        if (!_skipUnlessAvailable()) return;

        address oracle = 0x420000000000000000000000000000000000000F;
        if (oracle.code.length == 0) {
            console.log("no OP-Stack GasPriceOracle here - skipping L1 fee");
            return;
        }

        uint256 revealBytes = (B + 1) * 384 * THRESHOLD;
        bytes memory payload = new bytes(revealBytes);
        // Field elements are effectively incompressible; zero bytes would make
        // the estimate flattering and wrong.
        for (uint256 i = 0; i < revealBytes; ++i) {
            payload[i] = bytes1(uint8(uint256(keccak256(abi.encode(i)))));
        }

        (bool ok, bytes memory out) = oracle.staticcall(abi.encodeWithSignature("getL1Fee(bytes)", payload));
        if (!ok || out.length < 32) {
            console.log("getL1Fee unavailable - skipping");
            return;
        }

        uint256 l1Fee = abi.decode(out, (uint256));
        (uint256 perShare,) = harness.checkGas(_terms(B + 1));
        uint256 l2Gas = perShare * THRESHOLD;

        console.log("reveal calldata bytes", revealBytes);
        console.log("L1 data fee wei", l1Fee);
        console.log("L2 execution gas", l2Gas);
        console.log("L2 execution fee wei at 0.006 gwei", (l2Gas * 6_000_000));
        console.log("total wei", l1Fee + (l2Gas * 6_000_000));
    }

    /// Which batch sizes actually fit. The term count is `1 + B`, so this is
    /// the tuning knob if B=64 turns out to be too expensive.
    function test_batchSizeSweep() public view {
        if (!_skipUnlessAvailable()) return;

        uint256[5] memory batches = [uint256(4), 8, 16, 32, 64];
        for (uint256 i = 0; i < batches.length; ++i) {
            uint256 bsz = batches[i];
            (uint256 used,) = harness.checkGas(_terms(bsz + 1));
            console.log("B", bsz);
            console.log("  gas/share", used);
            console.log("  gas/reveal at threshold 3", used * THRESHOLD);
        }
    }

    /// Real points, not infinity: `e(P,Q) * e(-P,Q) == 1` by bilinearity.
    ///
    /// The gas tests above use infinity because the precompile charges by term
    /// count regardless of point values, but a harness that only ever saw
    /// infinity would not prove the encoding is right. This does: c0-before-c1
    /// ordering in G2, 48-byte field elements left-padded to 64, uncompressed.
    /// Get any of that wrong and the points still decode but pair to the wrong
    /// value.
    ///
    /// Generated by `cargo run -p bte-crypto --example eip2537_vectors`.
    function test_realPairingRelationHolds() public view {
        if (!_skipUnlessAvailable()) return;
        assertTrue(harness.check(PAIR_HOLDS), "e(P,Q)*e(-P,Q) should be 1");
    }

    /// The negative control, and the reason the test above means anything: a
    /// harness that always returned true would pass every other assertion here.
    /// `e(P,Q)` for generators is a primitive root, so it is not 1.
    function test_realPairingRelationFails() public view {
        if (!_skipUnlessAvailable()) return;
        assertFalse(harness.check(PAIR_FAILS), "e(P,Q) must not be 1");
    }

    /// Points off the curve are rejected by the precompile rather than quietly
    /// treated as a failed pairing - the distinction matters, because a caller
    /// must not be able to force a `false` by submitting garbage.
    function test_garbagePointsRevert() public {
        if (!_skipUnlessAvailable()) return;
        bytes memory bad = PAIR_HOLDS;
        bad[100] = bytes1(uint8(bad[100]) ^ 0xff);
        vm.expectRevert(BlsPairing.MalformedInput.selector);
        harness.check(bad);
    }

    /// Sanity: the wrapper rejects input that is not a whole number of terms,
    /// rather than passing it through and letting the precompile decide.
    function test_rejectsRaggedInput() public {
        vm.expectRevert(BlsPairing.MalformedInput.selector);
        harness.check(new bytes(383));

        vm.expectRevert(BlsPairing.MalformedInput.selector);
        harness.check(new bytes(0));
    }
}

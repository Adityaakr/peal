// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PealNames} from "../src/PealNames.sol";

contract PealNamesTest is Test {
    PealNames names;

    address constant HOST = address(0xA11CE);
    address constant STRANGER = address(0xB0B);
    bytes constant TERMS = bytes("WzEsImNvbmRfMjIwZDgyMDMxNWZiOWVmMTJmNzNjOGZiIiwicG9zdGVyIl0");

    event Claimed(bytes32 indexed nameHash, string name, address indexed claimedBy, bytes terms);

    function setUp() public {
        names = new PealNames();
    }

    function test_claimThenResolve() public {
        vm.prank(HOST);
        names.claim("shoonya", TERMS);

        assertEq(names.resolve("shoonya"), TERMS);
        assertTrue(names.isTaken("shoonya"));
        (address who, uint64 when) = names.ownerOf("shoonya");
        assertEq(who, HOST);
        assertEq(when, uint64(block.timestamp));
    }

    function test_unclaimedResolvesEmptyRatherThanReverting() public view {
        // A browser resolving a link somebody typed asks about names that do not
        // exist all the time. That is an answer, not a failure.
        assertEq(names.resolve("nobody-has-this"), bytes(""));
        assertFalse(names.isTaken("nobody-has-this"));
        (address who,) = names.ownerOf("nobody-has-this");
        assertEq(who, address(0));
    }

    function test_emitsTheNameSoTheSetIsEnumerable() public {
        vm.expectEmit(true, true, false, true);
        emit Claimed(keccak256("shoonya"), "shoonya", HOST, TERMS);
        vm.prank(HOST);
        names.claim("shoonya", TERMS);
    }

    /// The property the whole design rests on: a link that was shared cannot
    /// later mean a different auction.
    function test_aNameNeverMoves() public {
        vm.prank(HOST);
        names.claim("shoonya", TERMS);

        bytes memory other = bytes("a-completely-different-auction");

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(PealNames.NameTaken.selector, "shoonya"));
        names.claim("shoonya", other);

        // Not even by the person who claimed it.
        vm.prank(HOST);
        vm.expectRevert(abi.encodeWithSelector(PealNames.NameTaken.selector, "shoonya"));
        names.claim("shoonya", other);

        assertEq(names.resolve("shoonya"), TERMS);
    }

    function test_rejectsNamesThatAreTooShortOrTooLong() public {
        vm.expectRevert(PealNames.NameWrongLength.selector);
        names.claim("ab", TERMS);

        // Exactly at the bounds is fine.
        names.claim("abc", TERMS);
        names.claim("abcdefghijabcdefghijabcdefghij12", TERMS);

        vm.expectRevert(PealNames.NameWrongLength.selector);
        names.claim("abcdefghijabcdefghijabcdefghij123", TERMS);
    }

    function test_rejectsAnythingButLowercaseDigitsAndHyphen() public {
        // Uppercase is refused rather than folded: case folding on chain is a
        // lot of gas, and getting it subtly wrong lets two names collide.
        vm.expectRevert(abi.encodeWithSelector(PealNames.NameHasInvalidCharacter.selector, 0));
        names.claim("Shoonya", TERMS);

        vm.expectRevert(abi.encodeWithSelector(PealNames.NameHasInvalidCharacter.selector, 3));
        names.claim("abc_def", TERMS);

        vm.expectRevert(abi.encodeWithSelector(PealNames.NameHasInvalidCharacter.selector, 3));
        names.claim("abc def", TERMS);

        vm.expectRevert(abi.encodeWithSelector(PealNames.NameHasInvalidCharacter.selector, 3));
        names.claim("abc.eth", TERMS);

        // A multi-byte character trips on its first byte.
        vm.expectRevert(abi.encodeWithSelector(PealNames.NameHasInvalidCharacter.selector, 3));
        names.claim(unicode"abcé", TERMS);
    }

    function test_rejectsAHyphenAtEitherEnd() public {
        vm.expectRevert(PealNames.NameEdgeHyphen.selector);
        names.claim("-shoonya", TERMS);

        vm.expectRevert(PealNames.NameEdgeHyphen.selector);
        names.claim("shoonya-", TERMS);

        // In the middle it is fine, which is what makes two-word names readable.
        names.claim("shoonya-live", TERMS);
        assertTrue(names.isTaken("shoonya-live"));
    }

    function test_rejectsEmptyOrOversizedTerms() public {
        vm.expectRevert(PealNames.TermsEmpty.selector);
        names.claim("shoonya", bytes(""));

        bytes memory tooBig = new bytes(names.MAX_TERMS_BYTES() + 1);
        vm.expectRevert(PealNames.TermsTooLong.selector);
        names.claim("shoonya", tooBig);

        // Right at the cap is accepted.
        bytes memory atCap = new bytes(names.MAX_TERMS_BYTES());
        atCap[0] = 0x61;
        names.claim("shoonya", atCap);
        assertEq(names.resolve("shoonya").length, names.MAX_TERMS_BYTES());
    }

    function test_namesAreDistinctNotNormalised() public {
        names.claim("shoonya", TERMS);
        // "shoonya1" is a different name, not a variant of the first.
        names.claim("shoonya1", bytes("second"));
        assertEq(names.resolve("shoonya"), TERMS);
        assertEq(names.resolve("shoonya1"), bytes("second"));
    }

    function test_nameHashIsPrecomputableByAClient() public view {
        assertEq(names.nameHash("shoonya"), keccak256(bytes("shoonya")));
    }

    /// Anyone can claim any free name. That is the intended shape for a public
    /// registry, and it is stated here so the absence of an owner check reads as
    /// a decision rather than an omission.
    function testFuzz_anyoneMayClaimAFreeName(address caller) public {
        vm.assume(caller != address(0));
        vm.prank(caller);
        names.claim("open-to-all", TERMS);
        (address who,) = names.ownerOf("open-to-all");
        assertEq(who, caller);
    }
}

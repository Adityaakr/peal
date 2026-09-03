//! The batch tree, computed exactly as `crates/bte-coordinator/src/merkle.rs`
//! computes it.
//!
//! This is the load-bearing part of the program and the only part where being
//! *nearly* right is worthless. A root that differs from the coordinator's by
//! one byte is not a smaller error than a root that differs by everything:
//! every inclusion proof fails and the anchor silently stops meaning anything.
//!
//!     leaf   = sha256(position_le_u32 || payload)
//!     parent = sha256(left || right)      (an odd node is promoted unchanged)
//!     empty  = sha256("")
//!
//! Three conventions have to match, and each is easy to get subtly wrong:
//!
//!   - **The position is little-endian u32.** The EVM side of this repo is
//!     big-endian everywhere, so the instinct to write `to_be_bytes` here is
//!     strong and wrong. `merkle.rs` uses `to_le_bytes`.
//!   - **Pairs are not sorted.** OpenZeppelin's `MerkleProof`, which
//!     AuctionKit's *reveal* tree uses, hashes `(min, max)`. This tree does
//!     not. It hashes `(left, right)` in position order, so a verifier has to
//!     track index parity rather than sorting. These are two different trees in
//!     one repo and confusing them produces roots that look plausible.
//!   - **An odd node is promoted, not duplicated.** Duplicating a node is a
//!     known way to make two different leaf sets share a root.
//!
//! Hashing goes through `solana_program::hash::hashv`, which compiles to the
//! `sol_sha256` syscall on SBF and to a software sha256 on the host. The tests
//! below therefore exercise the same function the program runs, not a stand-in.

use solana_program::hash::hashv;

pub type Hash = [u8; 32];

fn sha256(parts: &[&[u8]]) -> Hash {
    hashv(parts).to_bytes()
}

/// `sha256(position_le_u32 || payload)`.
pub fn leaf(position: u32, payload: &[u8]) -> Hash {
    sha256(&[&position.to_le_bytes(), payload])
}

/// Ordering-commitment leaf: `sha256(intent_id || 0x00 || ct_hash)`.
///
/// Mirrors `ordering_leaf` in the coordinator and `orderingLeaf` in
/// packages/actions/src/commitment.ts. The `0x00` separator is not decoration:
/// without it a variable-length id concatenated onto a fixed-length hash lets
/// two different (id, hash) pairs produce identical bytes and therefore an
/// identical leaf.
pub fn ordering_leaf(intent_id: &[u8], ct_hash: &[u8]) -> Hash {
    sha256(&[intent_id, &[0x00], ct_hash])
}

/// The root over `leaves`, in position order. Empty hashes to `sha256("")`.
pub fn root(leaves: &[Hash]) -> Hash {
    if leaves.is_empty() {
        return sha256(&[]);
    }
    let mut level: Vec<Hash> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(sha256(&[&level[i], &level[i + 1]]));
            } else {
                next.push(level[i]); // promoted, not paired with itself
            }
            i += 2;
        }
        level = next;
    }
    level[0]
}

/// The sibling path proving `index` is in a tree of `leaves`, bottom up.
///
/// Levels where the node was promoted contribute no sibling, so the path is
/// shorter than `ceil(log2(n))` for some indices. The verifier reconstructs
/// which levels those were from `leaf_count` alone, which is why the count has
/// to be pinned onchain rather than supplied by the caller.
pub fn proof(leaves: &[Hash], index: usize) -> Vec<Hash> {
    let mut out = Vec::new();
    if index >= leaves.len() {
        return out;
    }
    let mut level: Vec<Hash> = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        if sibling < level.len() {
            out.push(level[sibling]);
        }
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(sha256(&[&level[i], &level[i + 1]]));
            } else {
                next.push(level[i]);
            }
            i += 2;
        }
        level = next;
        idx /= 2;
    }
    out
}

/// Does `payload` sit at `position` in the tree of `leaf_count` leaves whose
/// root is `expected_root`?
///
/// `leaf_count` is not optional bookkeeping. In a promotion tree, whether a
/// node is paired or carried up unchanged depends on how wide its level is, so
/// without the count there is no way to know which levels contribute a sibling
/// and the walk cannot be performed at all. It is also what bounds `position`,
/// so a caller cannot claim a slot the batch never had.
///
/// What the count does **not** do is uniquely determine the tree. Widths that
/// leave the shape unchanged along one index's path are interchangeable for
/// that index: in a 5-leaf tree, a proof for index 1 also verifies when the
/// width is declared as 6, 7 or 8, because none of those change where a
/// promotion falls on the way from index 1 to the root. Indices near the ragged
/// edge are bound tightly (index 4 of 5 accepts only 5); interior ones are not.
///
/// That is harmless here, and it is worth being precise about why rather than
/// implying a strength this does not have. The binding comes from
/// `expected_root`, which is anchored. `leaf_count` is read from the same
/// anchored account and never from instruction data, so a caller has no freedom
/// to search widths in the first place. If this function is ever reused
/// somewhere the count is caller-supplied, that reasoning does not carry.
///
/// The proof must be consumed exactly. A path with trailing hashes left over
/// is rejected rather than ignored: accepting it would let one valid proof be
/// padded into many distinct accepted proofs.
pub fn verify_inclusion(
    payload: &[u8],
    position: u32,
    leaf_count: u32,
    path: &[Hash],
    expected_root: &Hash,
) -> bool {
    if leaf_count == 0 || position >= leaf_count {
        return false;
    }
    let mut acc = leaf(position, payload);
    let mut idx = position as u64;
    let mut width = leaf_count as u64;
    let mut consumed = 0usize;

    while width > 1 {
        let has_sibling = if idx % 2 == 0 { idx + 1 < width } else { true };
        if has_sibling {
            let Some(sib) = path.get(consumed) else {
                return false;
            };
            consumed += 1;
            acc = if idx % 2 == 0 {
                sha256(&[&acc, sib])
            } else {
                sha256(&[sib, &acc])
            };
        }
        // else: this node was promoted unchanged, so the level costs no hash.
        idx /= 2;
        width = width.div_ceil(2);
    }

    consumed == path.len() && acc == *expected_root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> Hash {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    fn payloads() -> Vec<&'static [u8]> {
        vec![b"alpha", b"beta", b"gamma", b"delta", b"epsilon"]
    }

    /// The whole program is worthless if this fails.
    ///
    /// These values were produced by compiling
    /// `crates/bte-coordinator/src/merkle.rs` itself and printing its output,
    /// then independently reproduced through the browser path in
    /// `packages/explorer/src/merkle.ts`. Both agreed byte for byte. They are
    /// pinned here rather than recomputed by a helper in this file, because a
    /// second implementation living next to the first will happily agree with
    /// itself and disagree with the coordinator.
    #[test]
    fn leaves_and_roots_match_the_coordinator_exactly() {
        let expected_leaves = [
            hex32("44e7a99acb284b407b36a837f3b395abd876c4069a9e5a9f75fd0350ee5591f6"),
            hex32("5f18e1c39a28da8db8393cd204d2edf65c0563073d51aa128c6e191580f698c4"),
            hex32("67f9d50aabc720a4f96d46e0012263232a91fe90bea7b8d3a452118772f3d311"),
            hex32("e5e4c688a1211ce7b4daa650a0f7aab780dbdd6b0f493aa43e235b709cf6f488"),
            hex32("f27ab8512022c5fe03777fead1c23863cc70fbe11a75ce9357336ea67a34a44b"),
        ];
        for (i, p) in payloads().iter().enumerate() {
            assert_eq!(
                leaf(i as u32, p),
                expected_leaves[i],
                "leaf {i} disagrees with the coordinator"
            );
        }

        let expected_roots = [
            hex32("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            hex32("44e7a99acb284b407b36a837f3b395abd876c4069a9e5a9f75fd0350ee5591f6"),
            hex32("269079cbb76e0dfbff5dc2235c085a2b2462376c87cd6db348bb36771a669cce"),
            hex32("339349debb92b2ac73d516f3cedb17ff38354291e1d71f17ec393aada1f7ecf7"),
            hex32("233df706df01cacac412aae6830e15b7191019c8035b0fe2b2126bd6170fd70d"),
            hex32("e1d0298b3c7eb8b4821088b34d874138fd8343e00f0c4404eab03a2e832219f1"),
        ];
        for n in 0..=5usize {
            let leaves: Vec<Hash> = payloads()[..n]
                .iter()
                .enumerate()
                .map(|(i, p)| leaf(i as u32, p))
                .collect();
            assert_eq!(root(&leaves), expected_roots[n], "root n={n} disagrees");
        }
    }

    /// The empty root is `sha256("")`, not zero. A zero root is how the EVM
    /// anchor spells "not revealed yet", so the two must not collide.
    #[test]
    fn empty_root_is_sha256_of_nothing_and_not_zero() {
        assert_eq!(
            root(&[]),
            hex32("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert_ne!(root(&[]), [0u8; 32]);
    }

    /// Position is bound into the leaf, so the same payload at two slots is two
    /// different leaves. Without this the tree would not commit to an ordering.
    #[test]
    fn position_is_bound_into_the_leaf() {
        assert_ne!(leaf(0, b"same"), leaf(1, b"same"));
    }

    /// Little-endian, explicitly. Catches a `to_be_bytes` slip, which would
    /// agree with itself and disagree with the coordinator for every position
    /// above zero while looking perfectly correct at position zero.
    #[test]
    fn position_is_little_endian() {
        assert_eq!(leaf(1, b"x"), sha256(&[&[1u8, 0, 0, 0], b"x"]));
        assert_ne!(leaf(1, b"x"), sha256(&[&[0u8, 0, 0, 1], b"x"]));
    }

    /// This tree is order sensitive because pairs are not sorted. If someone
    /// "fixes" `sha256(&[&level[i], &level[i+1]])` into a sorted hash to match
    /// the AuctionKit reveal tree, this fails.
    #[test]
    fn pair_order_matters_unlike_the_auctionkit_reveal_tree() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        assert_ne!(sha256(&[&a, &b]), sha256(&[&b, &a]));
        assert_ne!(root(&[a, b]), root(&[b, a]));
    }

    /// Every leaf's proof must reconstruct the root at every tree size,
    /// including the odd widths where a node is promoted and the level
    /// contributes no sibling.
    #[test]
    fn every_proof_verifies_at_every_tree_size() {
        for n in 1..=33usize {
            let leaves: Vec<Hash> = (0..n).map(|i| leaf(i as u32, &[i as u8; 7])).collect();
            let r = root(&leaves);
            for i in 0..n {
                let path = proof(&leaves, i);
                assert!(
                    verify_inclusion(&[i as u8; 7], i as u32, n as u32, &path, &r),
                    "proof for leaf {i} of {n} did not verify"
                );
            }
        }
    }

    /// What the declared width actually buys, measured rather than assumed.
    ///
    /// A width that moves a promotion on the path from the leaf to the root is
    /// rejected. A width that does not move one is accepted, because the hash
    /// chain it produces is identical. Both halves are pinned here so that the
    /// doc comment on `verify_inclusion` cannot quietly drift into claiming
    /// the count is a unique commitment to the tree. It is not.
    ///
    /// This is safe only because `leaf_count` is read from the anchored
    /// account. See the note in `verify_inclusion`.
    #[test]
    fn the_declared_width_binds_the_shape_but_not_the_exact_count() {
        let leaves: Vec<Hash> = (0..5).map(|i| leaf(i as u32, &[i as u8; 7])).collect();
        let r = root(&leaves);

        // An interior leaf: widths 5..=8 all leave its path shape untouched.
        let path = proof(&leaves, 1);
        for w in [5u32, 6, 7, 8] {
            assert!(
                verify_inclusion(&[1u8; 7], 1, w, &path, &r),
                "width {w} changes no promotion on index 1's path, so it verifies"
            );
        }
        for w in [1u32, 2, 3, 4, 9, 16, 64] {
            assert!(
                !verify_inclusion(&[1u8; 7], 1, w, &path, &r),
                "width {w} should have been rejected"
            );
        }

        // The ragged edge is bound exactly: leaf 4 of 5 is the promoted node,
        // and any other width pairs it instead of carrying it.
        let edge = proof(&leaves, 4);
        assert!(verify_inclusion(&[4u8; 7], 4, 5, &edge, &r));
        for w in [1u32, 2, 3, 4, 6, 7, 8, 9, 64] {
            assert!(
                !verify_inclusion(&[4u8; 7], 4, w, &edge, &r),
                "width {w} should have been rejected at the ragged edge"
            );
        }
    }

    /// A position outside the anchored batch is rejected whatever path
    /// accompanies it. This is the bound that actually depends on the count
    /// being anchored rather than supplied.
    #[test]
    fn a_position_beyond_the_batch_is_rejected() {
        let leaves: Vec<Hash> = (0..5).map(|i| leaf(i as u32, &[i as u8; 7])).collect();
        let r = root(&leaves);
        let path = proof(&leaves, 1);
        for pos in [5u32, 6, 100, u32::MAX] {
            assert!(!verify_inclusion(&[1u8; 7], pos, 5, &path, &r), "pos {pos}");
        }
    }

    /// A padded proof is rejected rather than ignored. Accepting trailing
    /// hashes would turn one valid proof into unboundedly many accepted ones.
    #[test]
    fn a_padded_proof_is_rejected() {
        let leaves: Vec<Hash> = (0..4).map(|i| leaf(i as u32, &[i as u8; 7])).collect();
        let r = root(&leaves);
        let mut path = proof(&leaves, 2);
        assert!(verify_inclusion(&[2u8; 7], 2, 4, &path, &r));
        path.push([0xffu8; 32]);
        assert!(!verify_inclusion(&[2u8; 7], 2, 4, &path, &r));
    }

    /// Wrong payload, wrong position, truncated path, and out-of-range
    /// position all fail closed.
    #[test]
    fn tampering_fails_closed() {
        let leaves: Vec<Hash> = (0..7).map(|i| leaf(i as u32, &[i as u8; 7])).collect();
        let r = root(&leaves);
        let path = proof(&leaves, 3);

        assert!(verify_inclusion(&[3u8; 7], 3, 7, &path, &r));
        assert!(!verify_inclusion(&[9u8; 7], 3, 7, &path, &r), "payload");
        assert!(!verify_inclusion(&[3u8; 7], 4, 7, &path, &r), "position");
        assert!(!verify_inclusion(&[3u8; 7], 7, 7, &path, &r), "out of range");
        assert!(!verify_inclusion(&[3u8; 7], 3, 0, &path, &r), "zero count");
        assert!(
            !verify_inclusion(&[3u8; 7], 3, 7, &path[..path.len() - 1], &r),
            "truncated"
        );
        let mut wrong = r;
        wrong[0] ^= 1;
        assert!(!verify_inclusion(&[3u8; 7], 3, 7, &path, &wrong), "root");
    }

    /// The ordering leaf's separator does its job: an empty id with a hash must
    /// not collide with a non-empty id whose bytes start the same way.
    #[test]
    fn ordering_leaf_separator_prevents_collisions() {
        let h = [0xabu8; 32];
        assert_ne!(ordering_leaf(b"", &h), ordering_leaf(b"a", &h));
        // The classic ambiguity: ("ab", h) vs ("a", "b" || h) would collide
        // without the separator byte.
        let mut bh = vec![b'b'];
        bh.extend_from_slice(&h);
        assert_ne!(ordering_leaf(b"ab", &h), ordering_leaf(b"a", &bh));
    }
}

//! The reveal tree, computed exactly as `SealedBidAuction` verifies it.
//!
//! This is the load-bearing part of the program and the only part where being
//! *nearly* right is worthless. A root that differs from Solidity's by one byte
//! is not a smaller error than a root that differs by everything: every
//! `processReveals` proof fails, every bid is voided, and every bidder gets a
//! refund instead of an allocation.
//!
//! Two conventions have to match, and they are easy to get subtly wrong:
//!
//!   - **The leaf is double hashed.** `keccak256(keccak256(abi.encode(...)))`,
//!     matching `SealedBidAuction.revealLeaf`. The second hash is the standard
//!     defence against a leaf being reinterpreted as an internal node.
//!   - **Pairs are sorted before hashing.** OpenZeppelin's `MerkleProof` hashes
//!     `(min, max)`, not `(left, right)`. A tree built left-to-right produces a
//!     root the contract will reject for exactly half the trees, which is worse
//!     than always failing because it looks intermittent.
//!
//! Encoding is ABI, not SCALE. The whole point is agreeing with an EVM
//! contract, so the wire format has to be the EVM's.

use tiny_keccak::{Hasher, Keccak};

pub type Hash = [u8; 32];

fn keccak(parts: &[&[u8]]) -> Hash {
    let mut k = Keccak::v256();
    for p in parts {
        k.update(p);
    }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

/// A `uint` in ABI encoding: big-endian, right-aligned in 32 bytes.
fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// One reveal leaf.
///
/// Mirrors `SealedBidAuction.revealLeaf(bidId, quantity, tick, salt)`:
/// `keccak256(keccak256(abi.encode(uint32, uint256, uint16, bytes32)))`.
///
/// `quantity` is `u128` here rather than `u256`. Sale supplies that overflow
/// 128 bits are 3.4e38 base units, which is beyond any real token, and taking
/// the narrower type means the arithmetic cannot silently wrap in a `no_std`
/// program with no big-integer dependency. A caller that needs more will get a
/// compile error rather than a wrong root.
pub fn reveal_leaf(bid_id: u32, quantity: u128, tick: u16, salt: &Hash) -> Hash {
    let inner = keccak(&[&word(bid_id as u128), &word(quantity), &word(tick as u128), salt]);
    keccak(&[&inner])
}

/// Hash a pair the way OpenZeppelin's `MerkleProof` does: sorted, then
/// `keccak256(abi.encode(a, b))`.
fn hash_pair(a: &Hash, b: &Hash) -> Hash {
    if a <= b { keccak(&[a, b]) } else { keccak(&[b, a]) }
}

/// The root over `leaves`, in the order given.
///
/// An odd node is promoted unchanged to the next level, matching the reference
/// implementation in the Solidity tests. Order matters: the contract checks a
/// proof against a leaf built from `bidId`, so leaves must be supplied in bid
/// order or the proofs will not verify.
pub fn root(leaves: &[Hash]) -> Option<Hash> {
    if leaves.is_empty() {
        return None;
    }
    let mut level: sails_rs::Vec<Hash> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = sails_rs::Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(hash_pair(&level[i], &level[i + 1]));
            } else {
                // Promoted, not paired with itself. Duplicating a node here is
                // a known way to make two different leaf sets share a root.
                next.push(level[i]);
            }
            i += 2;
        }
        level = next;
    }
    Some(level[0])
}

/// The sibling path proving `index` is in the tree.
///
/// Returned in the order `MerkleProof.verify` consumes it, bottom up.
pub fn proof(leaves: &[Hash], index: usize) -> sails_rs::Vec<Hash> {
    let mut out = sails_rs::Vec::new();
    if index >= leaves.len() {
        return out;
    }
    let mut level: sails_rs::Vec<Hash> = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        // A promoted odd node has no sibling at this level and contributes
        // nothing to the path.
        if sibling < level.len() {
            out.push(level[sibling]);
        }
        let mut next = sails_rs::Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(hash_pair(&level[i], &level[i + 1]));
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

    /// The whole program is worthless if this fails.
    ///
    /// These are printed by `contracts/test/auctionkit/RevealVectors.t.sol`,
    /// which calls the same `revealLeaf` the deployed auction verifies against.
    /// If this engine's root differs from Solidity's by one byte then every
    /// proof it produces is rejected, every bid is voided, and every bidder is
    /// refunded instead of allocated. There is no partial credit here, so the
    /// values are pinned rather than recomputed by a second implementation that
    /// could agree with itself and disagree with the chain.
    #[test]
    fn leaves_and_root_match_solidity_exactly() {
        let salts = [
            hex32("ce134f70965209d2d935afb44cf7c156355a3544a464c5f775a5a9d8105bf6c0"),
            hex32("881dc84ebfc928329a16d9fa8d89d6e5b7a19a63cdd8f7086923ca5c8ece3fab"),
            hex32("9aab8e97f0ea7b3ee7a4c19009405d0539e062020da09ebccc462322fe926de4"),
        ];
        let qty = [120_000u128 * 10u128.pow(18), 300_000 * 10u128.pow(18), 450_000 * 10u128.pow(18)];
        let ticks = [18u16, 12, 7];

        let expected_leaves = [
            hex32("bdae3b3629d49dd46421d4cb026c1e5486548f20882a247cda5c34e38c2bc3f0"),
            hex32("56a8d7b0bfcc616b1232c3744c9b87a99f72ad1e00349dcef060603a754c7f2b"),
            hex32("3647a01972b7206feedb7bed1c42f5dedfc49d9582956e5e70d6ea78f3ccabc7"),
        ];

        let mut leaves = [[0u8; 32]; 3];
        for i in 0..3 {
            leaves[i] = reveal_leaf(i as u32, qty[i], ticks[i], &salts[i]);
            assert_eq!(leaves[i], expected_leaves[i], "leaf {i} disagrees with Solidity");
        }

        assert_eq!(
            root(&leaves).unwrap(),
            hex32("b3105451f7997ed232a3c68def810330e2aaf9f8a42940dbe67f3c6f154c50bf"),
            "root disagrees with Solidity"
        );
    }

    /// Every field must move the leaf, or that field is not really committed.
    #[test]
    fn every_field_is_bound_into_the_leaf() {
        let salt = [0x11u8; 32];
        let base = reveal_leaf(0, 10_000_000_000_000_000_000, 3, &salt);
        assert_ne!(base, reveal_leaf(1, 10_000_000_000_000_000_000, 3, &salt));
        assert_ne!(base, reveal_leaf(0, 10_000_000_000_000_000_001, 3, &salt));
        assert_ne!(base, reveal_leaf(0, 10_000_000_000_000_000_000, 4, &salt));
        assert_ne!(base, reveal_leaf(0, 10_000_000_000_000_000_000, 3, &[0x12u8; 32]));
    }

    #[test]
    fn pairs_are_sorted_so_order_within_a_pair_does_not_matter() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        assert_eq!(hash_pair(&a, &b), hash_pair(&b, &a));
    }

    #[test]
    fn a_single_leaf_is_its_own_root() {
        let a = [0xaau8; 32];
        assert_eq!(root(&[a]), Some(a));
    }

    #[test]
    fn empty_has_no_root() {
        assert_eq!(root(&[]), None);
    }

    /// The tree has to be sensitive to leaf order, because a proof is checked
    /// against a leaf built from bidId.
    #[test]
    fn leaf_order_changes_the_root() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        let c = [0x03u8; 32];
        assert_ne!(root(&[a, b, c]), root(&[c, b, a]));
    }

    /// Every leaf's proof must reconstruct the root, at every tree size,
    /// including the odd sizes where a node is promoted.
    #[test]
    fn every_proof_reconstructs_the_root() {
        for n in 1..=9usize {
            let leaves: sails_rs::Vec<Hash> = (0..n).map(|i| [i as u8 + 1; 32]).collect();
            let r = root(&leaves).unwrap();
            for (i, leaf) in leaves.iter().enumerate() {
                let mut acc = *leaf;
                for sib in proof(&leaves, i) {
                    acc = hash_pair(&acc, &sib);
                }
                assert_eq!(acc, r, "proof for leaf {i} of {n} did not reconstruct the root");
            }
        }
    }
}

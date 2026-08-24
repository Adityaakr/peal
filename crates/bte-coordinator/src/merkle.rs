//! Merkle root over (position, payload) leaves.
//!
//! leaf = sha256(position_le_u32 || payload), parent = sha256(left || right),
//! odd node promoted. Committed onchain in phase 7; recomputed by the SDK's
//! verifyAnchor.

use sha2::{Digest, Sha256};

pub fn leaf(position: u32, payload: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(position.to_le_bytes());
    h.update(payload);
    h.finalize().into()
}

/// Ordering-commitment leaf: sha256(intent_id || 0x00 || ct_hash_bytes).
///
/// A second leaf shape beside the reveal one above, because the two roots
/// answer different questions at different times. This one is committed while
/// the batch is still sealed, so it can only bind things that exist then: who
/// submitted, and which ciphertext. Mirrors `orderingLeaf` in
/// packages/actions/src/commitment.ts.
///
/// The 0x00 separator matters. Without it, a variable-length id concatenated
/// onto a fixed-length hash lets two different (id, hash) pairs produce the
/// same bytes and therefore the same leaf.
///
/// Slots with no bound intent — dummy padding, and ordinary v0 seals that are
/// not Private Actions — use an empty id. That is unambiguous: no real intent
/// id is empty, so their leaves cannot collide with a real one.
pub fn ordering_leaf(intent_id: &str, ct_hash: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(intent_id.as_bytes());
    h.update([0x00]);
    h.update(ct_hash);
    h.finalize().into()
}

/// Root over leaves in position order. Empty input hashes to sha256("").
pub fn root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return Sha256::digest([]).into();
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| {
                if pair.len() == 2 {
                    let mut h = Sha256::new();
                    h.update(pair[0]);
                    h.update(pair[1]);
                    h.finalize().into()
                } else {
                    pair[0] // odd node promoted
                }
            })
            .collect();
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_order_sensitive() {
        let a = leaf(0, b"alpha");
        let b = leaf(1, b"beta");
        let c = leaf(2, b"gamma");
        assert_eq!(root(&[a, b, c]), root(&[a, b, c]));
        assert_ne!(root(&[a, b, c]), root(&[b, a, c]));
        assert_ne!(root(&[a, b]), root(&[a, b, c]));
        // Single leaf promotes to root.
        assert_eq!(root(&[a]), a);
    }
}

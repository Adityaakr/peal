//! The native trees this crate maintains must produce exactly the nodes the
//! upstream circuit gadgets expect. Upstream ships in-memory reference trees
//! in its `circuits` module; these tests drive both with the same sequences
//! and compare roots, paths and insertion witnesses.

use ark_ff::UniformRand;
use peal_bonsai::params::Instance;
use peal_bonsai::trees::{root_from_path, ClaimedSet, ReceiptTree};
use peal_bonsai::Fr;
use zkpari::circuits::merkle::MerkleTree;
use zkpari::circuits::smt::SparseMerkleTree;

fn rng() -> impl ark_std::rand::RngCore {
    use ark_std::rand::SeedableRng;
    rand_chacha::ChaCha20Rng::seed_from_u64(7)
}

#[test]
fn receipt_tree_matches_upstream_roots_and_paths() {
    let inst = Instance::default_instance();
    let depth = 8;
    let mut ours = ReceiptTree::new(&inst.hash, depth);
    let mut theirs = MerkleTree::new(&inst.hash, depth);
    let mut rng = rng();
    assert_eq!(ours.root(), theirs.root(), "empty roots");
    let mut leaves = Vec::new();
    for i in 0..37u64 {
        let leaf = Fr::rand(&mut rng);
        leaves.push(leaf);
        assert_eq!(ours.append(leaf).unwrap(), i);
        assert_eq!(theirs.append(leaf) as u64, i);
        assert_eq!(ours.root(), theirs.root(), "root after {} leaves", i + 1);
        for p in 0..=i {
            let a = ours.path(p).unwrap();
            let b = theirs.path(p as usize);
            assert_eq!(a.siblings, b.siblings, "siblings of {p} at size {}", i + 1);
            assert_eq!(a.index_bits, b.index_bits);
            assert_eq!(
                root_from_path(&inst.hash, leaves[p as usize], &a),
                ours.root()
            );
        }
    }
    // Historical paths: the path for a leaf against an older root verifies
    // under that root, computed from a tree that has since grown.
    for size in 1..=37u64 {
        let old_root = ours.root_at(size).unwrap();
        let reference =
            ReceiptTree::from_leaves(&inst.hash, depth, &leaves[..size as usize]).unwrap();
        assert_eq!(old_root, reference.root(), "root_at({size})");
        for p in 0..size {
            let path = ours.path_at(p, size).unwrap();
            assert_eq!(
                root_from_path(&inst.hash, leaves[p as usize], &path),
                old_root
            );
            assert_eq!(path.siblings, reference.path(p).unwrap().siblings);
        }
    }
}

#[test]
fn claimed_set_matches_upstream_smt() {
    let inst = Instance::default_instance();
    let depth = 12;
    let mut ours = ClaimedSet::new(&inst.hash, depth);
    let mut theirs = SparseMerkleTree::new(&inst.hash, depth);
    assert_eq!(ours.root(), theirs.root());
    for pid in [0u64, 5, 4095, 77, 78, 1024, 3] {
        let a = ours.insert(&inst.hash, pid).unwrap();
        let b = theirs.insert(pid);
        assert_eq!(a.old_root, b.old_root);
        assert_eq!(a.new_root, b.new_root);
        assert_eq!(a.siblings, b.siblings);
        assert_eq!(ours.root(), theirs.root());
        assert!(ours.contains(pid));
    }
    assert!(ours.insert(&inst.hash, 5).is_err(), "double insert refused");
    let json = serde_json::to_string(&ours).unwrap();
    let back: ClaimedSet = serde_json::from_str(&json).unwrap();
    assert_eq!(back.root(), ours.root());
    assert_eq!(
        back.positions(),
        vec![0, 3, 4, 5, 77, 78, 1024, 4095]
            .into_iter()
            .filter(|p| ours.contains(*p))
            .collect::<Vec<_>>()
    );
}

//! Native tree maintenance for the receipt log and the wallet's nullifier
//! set, persistence-friendly and hash-for-hash compatible with the upstream
//! circuit gadgets.
//!
//! The upstream crate ships in-memory test trees (`zkpari::circuits::merkle`
//! and `::smt`) whose internals are private, so the ledger and the wallet keep
//! their own. They compute exactly the same nodes (`H(DOM_NODE, left, right)`
//! with zero leaves for empty positions); `tests/parity.rs` checks roots and
//! paths against the upstream trees for the same operation sequences.
//!
//! The receipt tree stands in for the paper's MMR exactly as upstream does: a
//! fixed-depth append-only tree whose root changes on every append. A receive
//! proof reveals the root it was made against, and the ledger accepts any of
//! its W most recent roots (`ledger::RootWindow`). [`ReceiptTree::path_at`]
//! recomputes a path against an older root so a wallet that fetched its path
//! a few appends ago still proves.

use std::collections::BTreeMap;

use ark_ff::{One, Zero};
use serde::{Deserialize, Serialize};
use zkpari::circuits::hasher::{hash, HashCfg, DOM_NODE};
use zkpari::circuits::merkle::MerklePath;
use zkpari::circuits::smt::SmtInsertion;

use crate::encoding::{fr_hex, fr_hex_vec};
use crate::{Error, Fr, Result};

fn node(cfg: &HashCfg, l: Fr, r: Fr) -> Fr {
    hash(cfg, DOM_NODE, &[l, r])
}

/// `zeros[j]` = root of the all-zero subtree of height `j`.
pub fn zero_digests(cfg: &HashCfg, depth: usize) -> Vec<Fr> {
    let mut zeros = Vec::with_capacity(depth + 1);
    zeros.push(Fr::zero());
    for j in 0..depth {
        let z = zeros[j];
        zeros.push(node(cfg, z, z));
    }
    zeros
}

/// Append-only fixed-depth tree over receipts. Keeps every level in memory
/// (a leaf count of millions is a few hundred MB; the ledger checkpoints the
/// leaves durably and rebuilds levels on open).
pub struct ReceiptTree {
    cfg: HashCfg,
    depth: usize,
    levels: Vec<Vec<Fr>>,
    zeros: Vec<Fr>,
}

impl ReceiptTree {
    pub fn new(cfg: &HashCfg, depth: usize) -> Self {
        Self {
            cfg: cfg.clone(),
            depth,
            levels: vec![Vec::new(); depth + 1],
            zeros: zero_digests(cfg, depth),
        }
    }

    /// Rebuild from a leaf sequence (the durable form).
    pub fn from_leaves(cfg: &HashCfg, depth: usize, leaves: &[Fr]) -> Result<Self> {
        let mut t = Self::new(cfg, depth);
        for leaf in leaves {
            t.append(*leaf)?;
        }
        Ok(t)
    }

    pub fn depth(&self) -> usize {
        self.depth
    }

    pub fn size(&self) -> u64 {
        self.levels[0].len() as u64
    }

    pub fn leaf(&self, pos: u64) -> Option<Fr> {
        self.levels[0].get(pos as usize).copied()
    }

    /// Append a leaf, returning its position. Only the nodes on the new
    /// leaf's path change, so this is `depth` hashes.
    pub fn append(&mut self, leaf: Fr) -> Result<u64> {
        let index = self.levels[0].len();
        if index >= 1usize << self.depth.min(63) {
            return Err(Error::ReceiptLogFull);
        }
        self.levels[0].push(leaf);
        let mut idx = index;
        for j in 0..self.depth {
            let pair = idx & !1;
            let left = self.levels[j][pair];
            let right = *self.levels[j].get(pair + 1).unwrap_or(&self.zeros[j]);
            let parent = node(&self.cfg, left, right);
            let up = &mut self.levels[j + 1];
            if up.len() > pair / 2 {
                up[pair / 2] = parent;
            } else {
                up.push(parent);
            }
            idx /= 2;
        }
        Ok(index as u64)
    }

    pub fn root(&self) -> Fr {
        *self.levels[self.depth]
            .first()
            .unwrap_or(&self.zeros[self.depth])
    }

    /// Path for `pos` against the current root.
    pub fn path(&self, pos: u64) -> Result<MerklePath> {
        self.path_at(pos, self.size())
    }

    /// Path for `pos` against the root the tree had when it held exactly
    /// `size` leaves. Nodes fully inside the first `size` leaves are the
    /// stored ones; a node straddling the boundary is recomputed from the
    /// leaves below it, padded with zeros; nodes beyond are zero subtrees.
    pub fn path_at(&self, pos: u64, size: u64) -> Result<MerklePath> {
        if pos >= size || size > self.size() {
            return Err(Error::Wallet(format!(
                "no receipt at position {pos} in a log of {size}"
            )));
        }
        let mut siblings = Vec::with_capacity(self.depth);
        let mut index_bits = Vec::with_capacity(self.depth);
        for j in 0..self.depth {
            let p = pos >> j;
            let sib = p ^ 1;
            siblings.push(self.node_at(j, sib, size));
            index_bits.push(p & 1 == 1);
        }
        Ok(MerklePath {
            siblings,
            index_bits,
        })
    }

    /// Root when the tree held `size` leaves.
    pub fn root_at(&self, size: u64) -> Result<Fr> {
        if size > self.size() {
            return Err(Error::Wallet("size exceeds the log".into()));
        }
        Ok(self.node_at(self.depth, 0, size))
    }

    /// The node at (`level`, `index`) in the tree of the first `size`
    /// leaves.
    fn node_at(&self, level: usize, index: u64, size: u64) -> Fr {
        let span = 1u64 << level;
        let start = index * span;
        if start >= size {
            return self.zeros[level];
        }
        if start + span <= size {
            // Fully covered: the stored node is exactly this one, because
            // appends never change a node whose subtree is full.
            return self.levels[level][index as usize];
        }
        if level == 0 {
            return self.levels[0][index as usize];
        }
        let l = self.node_at(level - 1, index * 2, size);
        let r = self.node_at(level - 1, index * 2 + 1, size);
        node(&self.cfg, l, r)
    }
}

/// Native root recomputation from a leaf and a path (for checks outside the
/// circuit, e.g. a wallet verifying a served path before proving).
pub fn root_from_path(cfg: &HashCfg, leaf: Fr, path: &MerklePath) -> Fr {
    let mut n = leaf;
    for (sib, is_right) in path.siblings.iter().zip(&path.index_bits) {
        n = if *is_right {
            node(cfg, *sib, n)
        } else {
            node(cfg, n, *sib)
        };
    }
    n
}

/// The wallet's sparse Merkle tree of claimed receipt positions: leaf `pid`
/// is `1` once claimed, every other leaf `0`. Only nodes on claimed paths are
/// stored, so it serializes as a map and stays small regardless of depth.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimedSet {
    depth: usize,
    /// `(height, index)` -> digest, for nodes on claimed paths. Keys are
    /// strings for JSON friendliness.
    #[serde(with = "node_map")]
    nodes: BTreeMap<(usize, u64), Fr>,
    #[serde(with = "fr_hex_vec")]
    defaults: Vec<Fr>,
}

mod node_map {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        m: &BTreeMap<(usize, u64), Fr>,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let v: Vec<(usize, u64, String)> = m
            .iter()
            .map(|((h, i), d)| (*h, *i, crate::encoding::fr_to_hex(d)))
            .collect();
        v.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<BTreeMap<(usize, u64), Fr>, D::Error> {
        let v = Vec::<(usize, u64, String)>::deserialize(d)?;
        v.into_iter()
            .map(|(h, i, s)| {
                crate::encoding::fr_from_hex(&s)
                    .map(|d| ((h, i), d))
                    .map_err(serde::de::Error::custom)
            })
            .collect()
    }
}

impl ClaimedSet {
    pub fn new(cfg: &HashCfg, depth: usize) -> Self {
        assert!(depth <= 64, "positions are u64");
        Self {
            depth,
            nodes: BTreeMap::new(),
            defaults: zero_digests(cfg, depth),
        }
    }

    pub fn depth(&self) -> usize {
        self.depth
    }

    fn node(&self, height: usize, index: u64) -> Fr {
        *self
            .nodes
            .get(&(height, index))
            .unwrap_or(&self.defaults[height])
    }

    pub fn root(&self) -> Fr {
        self.node(self.depth, 0)
    }

    pub fn contains(&self, pid: u64) -> bool {
        self.node(0, pid).is_one()
    }

    /// Claimed positions, ascending.
    pub fn positions(&self) -> Vec<u64> {
        self.nodes
            .keys()
            .filter(|(h, _)| *h == 0)
            .map(|(_, i)| *i)
            .collect()
    }

    fn check_pid(&self, pid: u64) -> Result<()> {
        if self.depth < 64 && pid >= (1u64 << self.depth) {
            return Err(Error::Wallet(format!(
                "position {pid} exceeds the {}-bit position space",
                self.depth
            )));
        }
        Ok(())
    }

    pub fn siblings(&self, pid: u64) -> Result<Vec<Fr>> {
        self.check_pid(pid)?;
        Ok((0..self.depth)
            .map(|h| self.node(h, (pid >> h) ^ 1))
            .collect())
    }

    /// Mark `pid` claimed and return the insertion witness. Errors (and
    /// leaves the set untouched) if it is already claimed.
    pub fn insert(&mut self, cfg: &HashCfg, pid: u64) -> Result<SmtInsertion> {
        self.check_pid(pid)?;
        if self.contains(pid) {
            return Err(Error::Wallet(format!("position {pid} already claimed")));
        }
        let old_root = self.root();
        let siblings = self.siblings(pid)?;
        let mut n = Fr::one();
        self.nodes.insert((0, pid), n);
        for (h, sib) in siblings.iter().enumerate() {
            let index = pid >> h;
            n = if index & 1 == 1 {
                node(cfg, *sib, n)
            } else {
                node(cfg, n, *sib)
            };
            self.nodes.insert((h + 1, index >> 1), n);
        }
        Ok(SmtInsertion {
            old_root,
            new_root: self.root(),
            pid,
            siblings,
        })
    }
}

/// A receipt opening: everything needed to claim one receipt. Travels only
/// encrypted to the receiver (see the inbox), never on the ledger.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReceiptOpening {
    /// Amount in base units (a decimal string on the wire, so JavaScript
    /// never sees it as a float).
    #[serde(with = "crate::manifest::u64_string")]
    pub amount: u64,
    #[serde(with = "fr_hex")]
    pub sender: Fr,
    #[serde(with = "fr_hex")]
    pub receiver: Fr,
    #[serde(with = "fr_hex")]
    pub randomness: Fr,
}

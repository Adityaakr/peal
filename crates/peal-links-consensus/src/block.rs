//! Blocks and transactions: what the validators order.
//!
//! A transaction is one ledger envelope tagged with its namespace. A block
//! is an ordered list of transactions over a parent digest, stamped with
//! the consensus round it was proposed in so the same content proposed
//! twice is two payloads. A block's digest is the SHA-256 of its exact
//! bytes as they travel on the wire; every validator hashes what it
//! received, never a re-encoding.

use peal_bonsai::account::{hex_32, Namespace, OpEnvelope, RegisterEnvelope};
use peal_bonsai::deposit::MintEnvelope;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// A block or transaction identifier: SHA-256 of the canonical bytes.
pub type Id = [u8; 32];

pub const VERSION: u8 = 1;
/// Largest transaction accepted from a peer or a client, in bytes.
pub const MAX_TX_BYTES: usize = 16 * 1024;
/// Largest number of transactions in one block.
pub const MAX_BLOCK_TXS: usize = 128;
/// Largest block, in bytes. Below the p2p message limit (1 MiB) with room
/// for framing.
pub const MAX_BLOCK_BYTES: usize = 900 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Envelope {
    Register(RegisterEnvelope),
    Op(OpEnvelope),
    Mint(MintEnvelope),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tx {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    pub envelope: Envelope,
}

impl Tx {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("transaction serializes")
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_TX_BYTES {
            return Err("transaction too large".into());
        }
        serde_json::from_slice(bytes).map_err(|e| format!("transaction: {e}"))
    }

    /// Identity of the transaction: the hash of its canonical encoding.
    pub fn id(&self) -> Id {
        Sha256::digest(self.encode()).into()
    }

    pub fn kind(&self) -> &'static str {
        match self.envelope {
            Envelope::Register(_) => "register",
            Envelope::Op(_) => "op",
            Envelope::Mint(_) => "mint",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Block {
    pub version: u8,
    pub epoch: u64,
    pub view: u64,
    /// Genesis is height 0; the first block is height 1.
    pub height: u64,
    #[serde(with = "hex_32")]
    pub parent: Id,
    pub txs: Vec<Tx>,
}

impl Block {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("block serializes")
    }

    /// Decode and check the shape: size, version, transaction count and
    /// no duplicate transaction within the block.
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_BLOCK_BYTES {
            return Err("block too large".into());
        }
        let block: Block = serde_json::from_slice(bytes).map_err(|e| format!("block: {e}"))?;
        if block.version != VERSION {
            return Err(format!("unsupported block version {}", block.version));
        }
        if block.height == 0 {
            return Err("block height must be positive".into());
        }
        if block.txs.len() > MAX_BLOCK_TXS {
            return Err("too many transactions in block".into());
        }
        let mut seen = std::collections::HashSet::with_capacity(block.txs.len());
        for tx in &block.txs {
            if tx.encode().len() > MAX_TX_BYTES {
                return Err("transaction too large".into());
            }
            if !seen.insert(tx.id()) {
                return Err("duplicate transaction in block".into());
            }
        }
        Ok(block)
    }

    pub fn digest_of(bytes: &[u8]) -> Id {
        Sha256::digest(bytes).into()
    }

    pub fn tx_ids(&self) -> Vec<Id> {
        self.txs.iter().map(Tx::id).collect()
    }
}

/// The genesis digest binds the chain to the circuit and the namespaces
/// it serves: validators configured for a different circuit or a
/// different set of ledgers never agree on a parent.
pub fn genesis(circuit_id: &[u8; 32], namespaces: &[Namespace]) -> Id {
    let mut sorted: Vec<Namespace> = namespaces.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut h = Sha256::new();
    h.update(b"peal-links/v1/consensus/genesis");
    h.update(circuit_id);
    h.update((sorted.len() as u32).to_le_bytes());
    for ns in &sorted {
        h.update(ns);
    }
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genesis_is_order_independent_and_circuit_bound() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [9u8; 32];
        assert_eq!(genesis(&c, &[a, b]), genesis(&c, &[b, a]));
        assert_ne!(genesis(&c, &[a, b]), genesis(&[8u8; 32], &[a, b]));
        assert_ne!(genesis(&c, &[a]), genesis(&c, &[a, b]));
    }

    #[test]
    fn block_shape_is_checked() {
        let block = Block {
            version: VERSION,
            epoch: 0,
            view: 1,
            height: 1,
            parent: [0u8; 32],
            txs: vec![],
        };
        let bytes = block.encode();
        assert_eq!(Block::decode(&bytes).unwrap(), block);
        let mut bad = block.clone();
        bad.version = 2;
        assert!(Block::decode(&bad.encode()).is_err());
        let mut bad = block;
        bad.height = 0;
        assert!(Block::decode(&bad.encode()).is_err());
    }
}

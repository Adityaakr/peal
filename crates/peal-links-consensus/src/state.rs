//! The replicated state: one `Ledger` per namespace plus the block store,
//! behind one lock. Everything a validator applies goes through
//! `apply_block`, in block order, so two validators that finalize the same
//! blocks hold byte-identical ledgers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use peal_bonsai::account::Namespace;
use peal_bonsai::encoding::fr_to_hex;
use peal_bonsai::ledger::{AccountView, Applied, HistoryRow, Ledger};
use peal_bonsai::{Error, Fr};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::block::{Block, Envelope, Id, Tx};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS blocks (
    digest     TEXT PRIMARY KEY,
    height     INTEGER NOT NULL,
    parent     TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    applied_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_height ON blocks(height);
CREATE TABLE IF NOT EXISTS head (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    height INTEGER NOT NULL,
    digest TEXT NOT NULL
);
"#;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LedgerSummary {
    pub namespace: String,
    pub seq: u64,
    pub receipt_count: u64,
    pub receipt_root: String,
    pub state_root: String,
    pub recent_roots: Vec<String>,
    pub minted_total: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReceiptPath {
    pub position: u64,
    pub size: u64,
    pub root: String,
    pub leaf: String,
    pub siblings: Vec<String>,
    pub index_bits: Vec<bool>,
}

/// The last applied block and the state it produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Head {
    pub height: u64,
    pub digest: Id,
    /// SHA-256 over every ledger's state root, in namespace order.
    pub root: [u8; 32],
}

pub struct State {
    ledgers: HashMap<Namespace, Ledger>,
    store: Connection,
    genesis: Id,
    head: Head,
    rng: rand_chacha::ChaCha20Rng,
}

pub type Shared = Arc<Mutex<State>>;

fn storage<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("block store: {e}"))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl State {
    /// Open the state over already-open ledgers. `store` is the block
    /// store path; `None` keeps it in memory (tests).
    pub fn open(
        ledgers: HashMap<Namespace, Ledger>,
        store: Option<&Path>,
        genesis: Id,
    ) -> Result<Self, String> {
        let conn = match store {
            Some(p) => {
                let c = storage(Connection::open(p))?;
                storage(c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"))?;
                c
            }
            None => storage(Connection::open_in_memory())?,
        };
        storage(conn.execute_batch(SCHEMA))?;
        let stored: Option<(i64, String)> = storage(
            conn.query_row("SELECT height, digest FROM head WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional(),
        )?;
        let mut state = Self {
            ledgers,
            store: conn,
            genesis,
            head: Head {
                height: 0,
                digest: genesis,
                root: [0u8; 32],
            },
            rng: peal_bonsai::os_rng(),
        };
        if let Some((height, digest)) = stored {
            let mut d = [0u8; 32];
            let raw = hex::decode(&digest).map_err(|e| e.to_string())?;
            if raw.len() != 32 {
                return Err("stored head digest is not 32 bytes".into());
            }
            d.copy_from_slice(&raw);
            state.head = Head {
                height: height as u64,
                digest: d,
                root: [0u8; 32],
            };
        }
        state.head.root = state.combined_root();
        Ok(state)
    }

    pub fn genesis(&self) -> Id {
        self.genesis
    }

    pub fn head(&self) -> Head {
        self.head
    }

    pub fn namespaces(&self) -> Vec<Namespace> {
        let mut v: Vec<Namespace> = self.ledgers.keys().copied().collect();
        v.sort();
        v
    }

    pub fn ledger(&self, ns: &Namespace) -> Option<&Ledger> {
        self.ledgers.get(ns)
    }

    /// SHA-256 over `(namespace, state_root)` pairs in namespace order.
    pub fn combined_root(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"peal-links/v1/consensus/state");
        for ns in self.namespaces() {
            h.update(ns);
            h.update(self.ledgers[&ns].state_root());
        }
        h.finalize().into()
    }

    /// Stateless admission of one transaction: the namespace is served
    /// and the envelope passes every check that needs no ledger state.
    pub fn check_tx(&self, tx: &Tx) -> peal_bonsai::Result<()> {
        let ledger = self
            .ledgers
            .get(&tx.namespace)
            .ok_or(Error::WrongNamespace)?;
        match &tx.envelope {
            Envelope::Register(env) => ledger.check_register(env),
            Envelope::Op(env) => ledger.check_op(env),
            Envelope::Mint(env) => ledger.check_mint(env),
        }
    }

    /// Stateless admission of a whole block (every transaction).
    pub fn check_block(&self, block: &Block) -> Result<(), String> {
        for (i, tx) in block.txs.iter().enumerate() {
            self.check_tx(tx)
                .map_err(|e| format!("transaction {i} ({}): {e}", tx.kind()))?;
        }
        Ok(())
    }

    /// Apply a finalized block that extends the head. Every transaction is
    /// applied in order through the ledger's own entry points (proofs
    /// re-verified); failures are per transaction and deterministic. The
    /// block and the new head are then recorded.
    pub fn apply_block(
        &mut self,
        block: &Block,
        bytes: &[u8],
        digest: Id,
    ) -> Result<Vec<peal_bonsai::Result<Applied>>, String> {
        if block.parent != self.head.digest || block.height != self.head.height + 1 {
            return Err(format!(
                "block {} at height {} does not extend the head {} at height {}",
                hex::encode(digest),
                block.height,
                hex::encode(self.head.digest),
                self.head.height
            ));
        }
        let mut results = Vec::with_capacity(block.txs.len());
        for tx in &block.txs {
            let r = match self.ledgers.get_mut(&tx.namespace) {
                None => Err(Error::WrongNamespace),
                Some(ledger) => match &tx.envelope {
                    Envelope::Register(env) => ledger.register(env),
                    Envelope::Op(env) => ledger
                        .apply_batch(std::slice::from_ref(env), &mut self.rng)
                        .pop()
                        .expect("one result per operation"),
                    Envelope::Mint(env) => ledger.mint(env),
                },
            };
            results.push(r);
        }
        let tx = storage(self.store.unchecked_transaction())?;
        storage(tx.execute(
            "INSERT OR REPLACE INTO blocks (digest, height, parent, bytes, applied_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                hex::encode(digest),
                block.height as i64,
                hex::encode(block.parent),
                bytes,
                now_unix()
            ],
        ))?;
        storage(tx.execute(
            "INSERT OR REPLACE INTO head (id, height, digest) VALUES (1, ?1, ?2)",
            params![block.height as i64, hex::encode(digest)],
        ))?;
        storage(tx.commit())?;
        self.head = Head {
            height: block.height,
            digest,
            root: self.combined_root(),
        };
        Ok(results)
    }

    /// Bytes of an applied block, for peers that missed it.
    pub fn block_bytes(&self, digest: &Id) -> Option<Vec<u8>> {
        self.store
            .query_row(
                "SELECT bytes FROM blocks WHERE digest = ?1",
                params![hex::encode(digest)],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Height of an applied block, if known.
    pub fn block_height(&self, digest: &Id) -> Option<u64> {
        self.store
            .query_row(
                "SELECT height FROM blocks WHERE digest = ?1",
                params![hex::encode(digest)],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
            .map(|h| h as u64)
    }

    pub fn applied_blocks(&self) -> u64 {
        self.store
            .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as u64
    }

    // ---- reads -------------------------------------------------------------

    pub fn account(
        &self,
        ns: &Namespace,
        account: &Fr,
    ) -> peal_bonsai::Result<Option<AccountView>> {
        self.ledgers
            .get(ns)
            .ok_or(Error::WrongNamespace)?
            .account(account)
    }

    pub fn summary(&self, ns: &Namespace) -> Option<LedgerSummary> {
        let ledger = self.ledgers.get(ns)?;
        Some(LedgerSummary {
            namespace: hex::encode(ledger.config().namespace),
            seq: ledger.seq(),
            receipt_count: ledger.receipt_count(),
            receipt_root: fr_to_hex(&ledger.receipt_root()),
            state_root: hex::encode(ledger.state_root()),
            recent_roots: ledger.recent_roots().iter().map(fr_to_hex).collect(),
            minted_total: ledger
                .minted_total()
                .map(|v| v.to_string())
                .unwrap_or_default(),
        })
    }

    pub fn path(
        &self,
        ns: &Namespace,
        pos: u64,
        size: Option<u64>,
    ) -> peal_bonsai::Result<ReceiptPath> {
        let ledger = self.ledgers.get(ns).ok_or(Error::WrongNamespace)?;
        let tree = ledger.receipt_tree();
        let size = size.unwrap_or(tree.size());
        let p = tree.path_at(pos, size)?;
        Ok(ReceiptPath {
            position: pos,
            size,
            root: fr_to_hex(&tree.root_at(size)?),
            leaf: fr_to_hex(&tree.leaf(pos).expect("path_at checked the position")),
            siblings: p.siblings.iter().map(fr_to_hex).collect(),
            index_bits: p.index_bits,
        })
    }

    pub fn history(
        &self,
        ns: &Namespace,
        from: u64,
        limit: usize,
    ) -> peal_bonsai::Result<Vec<HistoryRow>> {
        self.ledgers
            .get(ns)
            .ok_or(Error::WrongNamespace)?
            .history(from, limit.min(500))
    }
}

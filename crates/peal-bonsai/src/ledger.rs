//! The deterministic ledger: one namespace's account commitments, receipt
//! log, recent-root window and chained state root, over a durable sqlite
//! store.
//!
//! This module is the state transition function. The API layer hands it
//! envelopes and gets back either an `Applied` record or a typed rejection;
//! nothing here trusts the caller. In particular:
//!
//! - the old commitment comes from the store, never from the submission, so
//!   two operations racing from the same old state resolve by order of
//!   application (the second is `StaleCommitment`);
//! - the proof bytes are decoded strictly (canonical field elements, points
//!   on curve and in subgroup) before the pairing check;
//! - the revealed root must be one of the last `root_window` roots;
//! - every accepted operation is written in one transaction together with
//!   the receipt append, the new root, the account update and the chained
//!   state root, so a crash leaves either all or none of it.
//!
//! Replay: `ops` holds every accepted envelope in order. Reopening the store
//! rebuilds the receipt tree from `receipts`; `verify_replay` re-runs the
//! whole history through a fresh in-memory ledger, re-verifying every proof,
//! and checks it lands on the same state root.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use zkpari::ZkPari;

use zkpari::circuits::hasher::{hash, DOM_ACCT};

use crate::account::{Namespace, OpEnvelope, RegisterEnvelope};
use crate::deposit::{DepositCircuit, MintEnvelope};
use crate::encoding::{fr_from_hex, fr_to_hex, proof_from_bytes};
use crate::params::Instance;
use crate::trees::zero_digests;
use crate::trees::ReceiptTree;
use crate::{Error, Fr, Result, E};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
    account    TEXT PRIMARY KEY,   -- canonical hex of A
    pubkey     TEXT NOT NULL,      -- ed25519, hex
    com        TEXT NOT NULL,      -- current commitment, hex
    registered INTEGER NOT NULL,   -- state seq at registration
    updated    INTEGER NOT NULL    -- state seq of the last op
);
CREATE TABLE IF NOT EXISTS receipts (
    position INTEGER PRIMARY KEY,  -- append order
    leaf     TEXT NOT NULL,
    op_seq   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roots (
    size INTEGER PRIMARY KEY,      -- receipt-log size this root is for
    root TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
    deposit_id TEXT PRIMARY KEY,   -- chain domain + tx + log index
    receipt    TEXT NOT NULL,
    amount     TEXT NOT NULL,      -- decimal base units
    op_seq     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
    seq        INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,      -- 'register' | 'op' | 'mint'
    account    TEXT NOT NULL,
    envelope   TEXT NOT NULL,      -- JSON, exactly as accepted
    position   INTEGER,            -- receipt position for 'op'
    state_root TEXT NOT NULL,      -- after applying
    applied_at INTEGER NOT NULL
);
"#;

#[derive(Clone, Debug)]
pub struct LedgerConfig {
    pub namespace: Namespace,
    pub circuit_id: [u8; 32],
    /// How many most-recent receipt roots a receive may reveal (the paper's
    /// W). Includes the current root.
    pub root_window: usize,
}

/// One accepted history row: `(seq, kind, envelope JSON, receipt position)`.
pub type HistoryRow = (u64, String, String, Option<u64>);

/// What the ledger reports for an accepted operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    pub seq: u64,
    pub position: u64,
    pub receipt_root: Fr,
    pub state_root: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub account: Fr,
    pub com: Fr,
    pub updated_seq: u64,
}

/// The verifying keys the ledger checks proofs under.
#[derive(Clone)]
pub struct VerifyingKeys {
    pub op: zkpari::VerifyingKey<E>,
    pub deposit: zkpari::VerifyingKey<E>,
}

impl From<&crate::params::Keys> for VerifyingKeys {
    fn from(k: &crate::params::Keys) -> Self {
        Self {
            op: k.op.vk.clone(),
            deposit: k.deposit.vk.clone(),
        }
    }
}

pub struct Ledger {
    conn: Connection,
    inst: Instance,
    vk: VerifyingKeys,
    cfg: LedgerConfig,
    tree: ReceiptTree,
    /// The last `root_window` receipt roots, oldest first. Membership here
    /// is the recent-root policy, checked at the moment an operation is
    /// applied (never once per batch), so batched and replayed application
    /// accept exactly the same operations.
    recent: std::collections::VecDeque<Fr>,
    seq: u64,
    state_root: [u8; 32],
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn storage<T>(r: std::result::Result<T, rusqlite::Error>) -> Result<T> {
    r.map_err(|e| Error::Storage(e.to_string()))
}

impl Ledger {
    pub fn open(
        path: &std::path::Path,
        inst: Instance,
        vk: VerifyingKeys,
        cfg: LedgerConfig,
    ) -> Result<Self> {
        let conn = storage(Connection::open(path))?;
        storage(conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"))?;
        Self::init(conn, inst, vk, cfg)
    }

    pub fn open_in_memory(inst: Instance, vk: VerifyingKeys, cfg: LedgerConfig) -> Result<Self> {
        let conn = storage(Connection::open_in_memory())?;
        Self::init(conn, inst, vk, cfg)
    }

    fn init(
        conn: Connection,
        inst: Instance,
        vk: VerifyingKeys,
        cfg: LedgerConfig,
    ) -> Result<Self> {
        storage(conn.execute_batch(SCHEMA))?;
        // Bind the store to its namespace and circuit; a store opened under
        // another configuration is refused rather than reinterpreted.
        for (key, value) in [
            ("namespace", hex::encode(cfg.namespace)),
            ("circuit_id", hex::encode(cfg.circuit_id)),
        ] {
            let existing: Option<String> = storage(
                conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                    r.get(0)
                })
                .optional(),
            )?;
            match existing {
                None => {
                    storage(conn.execute(
                        "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                        params![key, value],
                    ))?;
                }
                Some(v) if v == value => {}
                Some(v) => {
                    return Err(Error::Storage(format!(
                        "store is bound to {key} {v}, opened with {value}"
                    )))
                }
            }
        }
        let leaves: Vec<Fr> = {
            let mut stmt =
                storage(conn.prepare("SELECT leaf FROM receipts ORDER BY position ASC"))?;
            let rows = storage(stmt.query_map([], |r| r.get::<_, String>(0)))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(fr_from_hex(&storage(row)?)?);
            }
            out
        };
        let tree = ReceiptTree::from_leaves(&inst.hash, inst.receipt_depth, &leaves)?;
        let recent = recent_from_tree(&tree, cfg.root_window);
        let (seq, state_root): (u64, [u8; 32]) = storage(
            conn.query_row(
                "SELECT seq, state_root FROM ops ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?)),
            )
            .optional(),
        )?
        .map(|(s, root)| {
            let bytes = hex::decode(root).unwrap_or_default();
            let mut out = [0u8; 32];
            if bytes.len() == 32 {
                out.copy_from_slice(&bytes);
            }
            (s, out)
        })
        .unwrap_or((0, genesis_root(&cfg)));
        // A consistency check the cheap way: the root recorded for the
        // current size must be the rebuilt tree's root.
        if tree.size() > 0 {
            let recorded: Option<String> = storage(
                conn.query_row(
                    "SELECT root FROM roots WHERE size = ?1",
                    params![tree.size() as i64],
                    |r| r.get(0),
                )
                .optional(),
            )?;
            match recorded {
                Some(r) if fr_from_hex(&r)? == tree.root() => {}
                _ => {
                    return Err(Error::Storage(
                        "receipt log does not match its recorded root".into(),
                    ))
                }
            }
        }
        Ok(Self {
            conn,
            inst,
            vk,
            cfg,
            tree,
            recent,
            seq,
            state_root,
        })
    }

    pub fn config(&self) -> &LedgerConfig {
        &self.cfg
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn state_root(&self) -> [u8; 32] {
        self.state_root
    }

    pub fn receipt_root(&self) -> Fr {
        self.tree.root()
    }

    pub fn receipt_count(&self) -> u64 {
        self.tree.size()
    }

    pub fn receipt_tree(&self) -> &ReceiptTree {
        &self.tree
    }

    pub fn account(&self, account: &Fr) -> Result<Option<AccountView>> {
        storage(
            self.conn
                .query_row(
                    "SELECT com, updated FROM accounts WHERE account = ?1",
                    params![fr_to_hex(account)],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional(),
        )?
        .map(|(com, updated)| {
            Ok(AccountView {
                account: *account,
                com: fr_from_hex(&com)?,
                updated_seq: updated as u64,
            })
        })
        .transpose()
    }

    /// The roots a receive may currently reveal, most recent last.
    pub fn recent_roots(&self) -> Vec<Fr> {
        self.recent.iter().copied().collect()
    }

    fn root_is_recent(&self, root: &Fr) -> bool {
        self.recent.contains(root)
    }

    /// `Com_acct(0, root_empty; r)`: the only commitment a fresh account may
    /// register at.
    pub fn initial_commitment(&self, randomness: &Fr) -> Fr {
        let empty_root = zero_digests(&self.inst.hash, self.inst.null_depth)[self.inst.null_depth];
        hash(
            &self.inst.hash,
            DOM_ACCT,
            &[Fr::from(0u64), empty_root, *randomness],
        )
    }

    /// Register an account at its initial commitment.
    pub fn register(&mut self, env: &RegisterEnvelope) -> Result<Applied> {
        let account = env.verify(&self.cfg.namespace)?;
        if self.account(&account)?.is_some() {
            return Err(Error::AccountExists);
        }
        let com0 = self.initial_commitment(&env.randomness);
        let seq = self.seq + 1;
        let state_root = chain_root(
            &self.state_root,
            seq,
            b"register",
            &account,
            &com0,
            &Fr::from(0u64),
            &self.tree.root(),
        );
        let json = serde_json::to_string(env).expect("envelope serializes");
        let tx = storage(self.conn.unchecked_transaction())?;
        storage(tx.execute(
            "INSERT INTO accounts (account, pubkey, com, registered, updated) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![fr_to_hex(&account), hex::encode(env.pubkey), fr_to_hex(&com0), seq as i64],
        ))?;
        storage(tx.execute(
            "INSERT INTO ops (seq, kind, account, envelope, position, state_root, applied_at) VALUES (?1, 'register', ?2, ?3, NULL, ?4, ?5)",
            params![seq as i64, fr_to_hex(&account), json, hex::encode(state_root), now_unix() as i64],
        ))?;
        storage(tx.commit())?;
        self.seq = seq;
        self.state_root = state_root;
        Ok(Applied {
            seq,
            position: u64::MAX,
            receipt_root: self.tree.root(),
            state_root,
        })
    }

    /// Everything that can be checked without state: namespace, circuit,
    /// signature, and the proof's encoding. Returns the decoded proof.
    fn admit(&self, env: &OpEnvelope) -> Result<zkpari::Proof<E>> {
        if env.namespace != self.cfg.namespace {
            return Err(Error::WrongNamespace);
        }
        if env.circuit_id != self.cfg.circuit_id {
            return Err(Error::Wire("operation is for a different circuit".into()));
        }
        env.verify_signature()?;
        proof_from_bytes(&env.proof)
    }

    fn public_input(env: &OpEnvelope, com_old: Fr) -> Vec<Fr> {
        vec![env.account, com_old, env.com_new, env.receipt, env.root]
    }

    /// Apply one operation. Verifies the proof individually.
    pub fn apply(&mut self, env: &OpEnvelope) -> Result<Applied> {
        let proof = self.admit(env)?;
        let current = self.account(&env.account)?.ok_or(Error::UnknownAccount)?;
        if current.com != env.com {
            return Err(Error::StaleCommitment);
        }
        if !self.root_is_recent(&env.root) {
            return Err(Error::RootNotRecent);
        }
        if !ZkPari::<E>::verify(&proof, &self.vk.op, &Self::public_input(env, current.com)) {
            return Err(Error::InvalidProof);
        }
        self.apply_verified(env, &current)
    }

    /// Everything about an operation that can be checked without the
    /// ledger's state: namespace, circuit, signature, encoding, and the
    /// proof itself against the commitment the envelope claims to spend
    /// from (`env.com`). Whether that commitment is the account's current
    /// one, and whether the revealed root is recent, are decided when the
    /// operation is applied. Used by a validator to vote on a proposed
    /// block before it is final.
    pub fn check_op(&self, env: &OpEnvelope) -> Result<()> {
        let proof = self.admit(env)?;
        if !ZkPari::<E>::verify(&proof, &self.vk.op, &Self::public_input(env, env.com)) {
            return Err(Error::InvalidProof);
        }
        Ok(())
    }

    /// Stateless checks of a registration: namespace binding and signature.
    pub fn check_register(&self, env: &RegisterEnvelope) -> Result<()> {
        env.verify(&self.cfg.namespace).map(|_| ())
    }

    /// Stateless checks of a mint: namespace, circuit, deposit id shape and
    /// the deposit proof. Whether the deposit id was already credited is
    /// decided when the mint is applied.
    pub fn check_mint(&self, env: &MintEnvelope) -> Result<()> {
        let intent = &env.intent;
        if intent.namespace != self.cfg.namespace {
            return Err(Error::WrongNamespace);
        }
        if intent.circuit_id != self.cfg.circuit_id {
            return Err(Error::Wire("deposit is for a different circuit".into()));
        }
        if env.deposit_id.is_empty() || env.deposit_id.len() > 200 {
            return Err(Error::Wire("bad deposit id".into()));
        }
        let proof = proof_from_bytes(&intent.proof)?;
        let input = DepositCircuit::public_input_for(intent.amount, intent.receipt);
        if !ZkPari::<E>::verify(&proof, &self.vk.deposit, &input) {
            return Err(Error::InvalidProof);
        }
        Ok(())
    }

    /// Apply a batch. Proofs are batch-verified against the commitments the
    /// accounts hold *now*; if the batch check fails, every proof is verified
    /// alone so one bad proof only rejects itself. Operations then apply in
    /// order, and an operation whose account moved earlier in the same batch
    /// is rejected as stale (its proof was made against the old commitment).
    pub fn apply_batch<R: ark_std::rand::RngCore>(
        &mut self,
        envs: &[OpEnvelope],
        rng: &mut R,
    ) -> Vec<Result<Applied>> {
        let mut results: Vec<Option<Result<Applied>>> = vec![None; envs.len()];
        let mut candidates = Vec::new();
        for (i, env) in envs.iter().enumerate() {
            match self.admit(env).and_then(|proof| {
                let current = self.account(&env.account)?.ok_or(Error::UnknownAccount)?;
                if current.com != env.com {
                    return Err(Error::StaleCommitment);
                }
                if !self.root_is_recent(&env.root) {
                    return Err(Error::RootNotRecent);
                }
                Ok((proof, current))
            }) {
                Ok((proof, current)) => candidates.push((i, proof, current)),
                Err(e) => results[i] = Some(Err(e)),
            }
        }
        // Verify: all at once, then individually if that fails.
        let claims: Vec<(zkpari::Proof<E>, Vec<Fr>)> = candidates
            .iter()
            .map(|(i, proof, current)| (proof.clone(), Self::public_input(&envs[*i], current.com)))
            .collect();
        let mut valid = vec![true; candidates.len()];
        if !ZkPari::<E>::batch_verify(&claims, &self.vk.op, rng) {
            for (k, (proof, input)) in claims.iter().enumerate() {
                valid[k] = ZkPari::<E>::verify(proof, &self.vk.op, input);
            }
        }
        for (k, (i, _proof, current)) in candidates.into_iter().enumerate() {
            if !valid[k] {
                results[i] = Some(Err(Error::InvalidProof));
                continue;
            }
            // Re-read: an earlier op in this batch may have moved the account.
            let now = match self.account(&envs[i].account) {
                Ok(Some(a)) => a,
                Ok(None) => {
                    results[i] = Some(Err(Error::UnknownAccount));
                    continue;
                }
                Err(e) => {
                    results[i] = Some(Err(e));
                    continue;
                }
            };
            if now.com != current.com {
                results[i] = Some(Err(Error::StaleCommitment));
                continue;
            }
            results[i] = Some(self.apply_verified(&envs[i], &now));
        }
        results
            .into_iter()
            .map(|r| r.expect("every slot filled"))
            .collect()
    }

    /// Write an already-verified operation. `current` must be the account's
    /// state at verification time; it is re-checked under the transaction.
    fn apply_verified(&mut self, env: &OpEnvelope, current: &AccountView) -> Result<Applied> {
        let latest = self.account(&env.account)?.ok_or(Error::UnknownAccount)?;
        if latest.com != current.com {
            return Err(Error::StaleCommitment);
        }
        // The window is judged against the state at application time, so
        // an operation late in a batch sees the appends made by the earlier
        // ones, exactly as a replay would.
        if !self.root_is_recent(&env.root) {
            return Err(Error::RootNotRecent);
        }
        let seq = self.seq + 1;
        let tx = storage(self.conn.unchecked_transaction())?;
        // Append to the in-memory tree last so a storage failure cannot leave
        // it ahead of the store: compute the post-append root first via a
        // dry run on a clone of the frontier.
        let position = self.tree.size();
        if position >= self.inst.max_positions() {
            return Err(Error::ReceiptLogFull);
        }
        self.tree.append(env.receipt)?;
        push_recent(&mut self.recent, self.tree.root(), self.cfg.root_window);
        let receipt_root = self.tree.root();
        let state_root = chain_root(
            &self.state_root,
            seq,
            b"op",
            &env.account,
            &env.com_new,
            &env.receipt,
            &receipt_root,
        );
        let json = serde_json::to_string(env).expect("envelope serializes");
        let write = (|| -> Result<()> {
            storage(tx.execute(
                "INSERT INTO receipts (position, leaf, op_seq) VALUES (?1, ?2, ?3)",
                params![position as i64, fr_to_hex(&env.receipt), seq as i64],
            ))?;
            storage(tx.execute(
                "INSERT INTO roots (size, root) VALUES (?1, ?2)",
                params![(position + 1) as i64, fr_to_hex(&receipt_root)],
            ))?;
            storage(tx.execute(
                "UPDATE accounts SET com = ?1, updated = ?2 WHERE account = ?3",
                params![fr_to_hex(&env.com_new), seq as i64, fr_to_hex(&env.account)],
            ))?;
            storage(tx.execute(
                "INSERT INTO ops (seq, kind, account, envelope, position, state_root, applied_at) VALUES (?1, 'op', ?2, ?3, ?4, ?5, ?6)",
                params![seq as i64, fr_to_hex(&env.account), json, position as i64, hex::encode(state_root), now_unix() as i64],
            ))?;
            storage(tx.commit())
        })();
        if let Err(e) = write {
            // Roll the in-memory tree back by rebuilding from the store.
            self.reload_tree()?;
            return Err(e);
        }
        self.seq = seq;
        self.state_root = state_root;
        Ok(Applied {
            seq,
            position,
            receipt_root,
            state_root,
        })
    }

    /// Credit a finalized deposit by appending its mint receipt. The proof
    /// binds the receipt to the observed amount; `deposit_id` deduplicates
    /// by full event identity within the namespace.
    pub fn mint(&mut self, env: &MintEnvelope) -> Result<Applied> {
        let intent = &env.intent;
        if intent.namespace != self.cfg.namespace {
            return Err(Error::WrongNamespace);
        }
        if intent.circuit_id != self.cfg.circuit_id {
            return Err(Error::Wire("deposit is for a different circuit".into()));
        }
        if env.deposit_id.is_empty() || env.deposit_id.len() > 200 {
            return Err(Error::Wire("bad deposit id".into()));
        }
        let seen: Option<String> = storage(
            self.conn
                .query_row(
                    "SELECT receipt FROM deposits WHERE deposit_id = ?1",
                    params![env.deposit_id],
                    |r| r.get(0),
                )
                .optional(),
        )?;
        if seen.is_some() {
            return Err(Error::Storage("deposit already credited".into()));
        }
        let proof = proof_from_bytes(&intent.proof)?;
        let input = DepositCircuit::public_input_for(intent.amount, intent.receipt);
        if !ZkPari::<E>::verify(&proof, &self.vk.deposit, &input) {
            return Err(Error::InvalidProof);
        }
        let seq = self.seq + 1;
        let position = self.tree.size();
        if position >= self.inst.max_positions() {
            return Err(Error::ReceiptLogFull);
        }
        let tx = storage(self.conn.unchecked_transaction())?;
        self.tree.append(intent.receipt)?;
        push_recent(&mut self.recent, self.tree.root(), self.cfg.root_window);
        let receipt_root = self.tree.root();
        let mint_account = crate::deposit::mint_sender();
        let state_root = chain_root(
            &self.state_root,
            seq,
            b"mint",
            &mint_account,
            &Fr::from(intent.amount),
            &intent.receipt,
            &receipt_root,
        );
        let json = serde_json::to_string(env).expect("envelope serializes");
        let write = (|| -> Result<()> {
            storage(tx.execute(
                "INSERT INTO receipts (position, leaf, op_seq) VALUES (?1, ?2, ?3)",
                params![position as i64, fr_to_hex(&intent.receipt), seq as i64],
            ))?;
            storage(tx.execute(
                "INSERT INTO roots (size, root) VALUES (?1, ?2)",
                params![(position + 1) as i64, fr_to_hex(&receipt_root)],
            ))?;
            storage(tx.execute(
                "INSERT INTO deposits (deposit_id, receipt, amount, op_seq) VALUES (?1, ?2, ?3, ?4)",
                params![env.deposit_id, fr_to_hex(&intent.receipt), intent.amount.to_string(), seq as i64],
            ))?;
            storage(tx.execute(
                "INSERT INTO ops (seq, kind, account, envelope, position, state_root, applied_at) VALUES (?1, 'mint', ?2, ?3, ?4, ?5, ?6)",
                params![seq as i64, fr_to_hex(&mint_account), json, position as i64, hex::encode(state_root), now_unix() as i64],
            ))?;
            storage(tx.commit())
        })();
        if let Err(e) = write {
            self.reload_tree()?;
            return Err(e);
        }
        self.seq = seq;
        self.state_root = state_root;
        Ok(Applied {
            seq,
            position,
            receipt_root,
            state_root,
        })
    }

    /// Total base units ever minted into this namespace (the ledger's
    /// aggregate liability ceiling; user balances are proof-enforced, this
    /// is bookkeeping for reconciliation against gateway reserves).
    pub fn minted_total(&self) -> Result<u128> {
        let mut stmt = storage(self.conn.prepare("SELECT amount FROM deposits"))?;
        let rows = storage(stmt.query_map([], |r| r.get::<_, String>(0)))?;
        let mut total: u128 = 0;
        for row in rows {
            let v: u128 = storage(row)?
                .parse()
                .map_err(|_| Error::Storage("bad amount".into()))?;
            total += v;
        }
        Ok(total)
    }

    fn reload_tree(&mut self) -> Result<()> {
        let mut stmt = storage(
            self.conn
                .prepare("SELECT leaf FROM receipts ORDER BY position ASC"),
        )?;
        let rows = storage(stmt.query_map([], |r| r.get::<_, String>(0)))?;
        let mut leaves = Vec::new();
        for row in rows {
            leaves.push(fr_from_hex(&storage(row)?)?);
        }
        drop(stmt);
        self.tree = ReceiptTree::from_leaves(&self.inst.hash, self.inst.receipt_depth, &leaves)?;
        self.recent = recent_from_tree(&self.tree, self.cfg.root_window);
        Ok(())
    }

    /// The accepted history, in order: (seq, kind, envelope JSON, position).
    pub fn history(&self, from_seq: u64, limit: usize) -> Result<Vec<HistoryRow>> {
        let mut stmt = storage(self.conn.prepare(
            "SELECT seq, kind, envelope, position FROM ops WHERE seq >= ?1 ORDER BY seq ASC LIMIT ?2",
        ))?;
        let rows = storage(stmt.query_map(params![from_seq as i64, limit as i64], |r| {
            Ok((
                r.get::<_, i64>(0)? as u64,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?.map(|p| p as u64),
            ))
        }))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(storage(row)?);
        }
        Ok(out)
    }

    /// Re-run the entire accepted history through a fresh in-memory ledger,
    /// re-verifying every proof, and compare the resulting state root with
    /// this store's. Returns the replayed root.
    pub fn verify_replay(&self) -> Result<[u8; 32]> {
        let mut fresh =
            Ledger::open_in_memory(self.inst.clone(), self.vk.clone(), self.cfg.clone())?;
        let mut from = 1;
        loop {
            let page = self.history(from, 256)?;
            if page.is_empty() {
                break;
            }
            for (seq, kind, json, _pos) in &page {
                let applied = match kind.as_str() {
                    "register" => {
                        let env: RegisterEnvelope = serde_json::from_str(json)
                            .map_err(|e| Error::Storage(format!("replay parse: {e}")))?;
                        fresh.register(&env)?
                    }
                    "op" => {
                        let env: OpEnvelope = serde_json::from_str(json)
                            .map_err(|e| Error::Storage(format!("replay parse: {e}")))?;
                        fresh.apply(&env)?
                    }
                    "mint" => {
                        let env: MintEnvelope = serde_json::from_str(json)
                            .map_err(|e| Error::Storage(format!("replay parse: {e}")))?;
                        fresh.mint(&env)?
                    }
                    other => return Err(Error::Storage(format!("unknown op kind {other}"))),
                };
                if applied.seq != *seq {
                    return Err(Error::Storage("replay sequence diverged".into()));
                }
                from = seq + 1;
            }
        }
        if fresh.state_root() != self.state_root {
            return Err(Error::Storage("replayed state root differs".into()));
        }
        Ok(fresh.state_root())
    }
}

/// Record `root` as the newest recent root, dropping the oldest beyond
/// `window`. A free function so it borrows only the fields it touches
/// while a storage transaction holds the connection.
fn push_recent(recent: &mut std::collections::VecDeque<Fr>, root: Fr, window: usize) {
    recent.push_back(root);
    while recent.len() > window.max(1) {
        recent.pop_front();
    }
}

/// The last `window` roots of `tree` (including the empty root when the
/// log is short), oldest first.
fn recent_from_tree(tree: &ReceiptTree, window: usize) -> std::collections::VecDeque<Fr> {
    let size = tree.size();
    let w = window.max(1) as u64;
    let from = size.saturating_sub(w - 1);
    (from..=size)
        .map(|s| tree.root_at(s).expect("size within the log"))
        .collect()
}

fn genesis_root(cfg: &LedgerConfig) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"peal-links/v1/state-genesis");
    h.update(cfg.namespace);
    h.update(cfg.circuit_id);
    h.finalize().into()
}

fn chain_root(
    prev: &[u8; 32],
    seq: u64,
    kind: &[u8],
    account: &Fr,
    com: &Fr,
    receipt: &Fr,
    receipt_root: &Fr,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"peal-links/v1/state");
    h.update(prev);
    h.update(seq.to_le_bytes());
    h.update(kind);
    h.update(crate::encoding::fr_to_bytes(account));
    h.update(crate::encoding::fr_to_bytes(com));
    h.update(crate::encoding::fr_to_bytes(receipt));
    h.update(crate::encoding::fr_to_bytes(receipt_root));
    h.finalize().into()
}

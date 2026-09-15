//! The private state a Peal Links client holds for one account on one
//! namespace, and witness construction for the operation-hiding circuit.
//!
//! What the ledger knows about this account is one commitment. Everything
//! that opens it lives here: the balance, the current opening randomness,
//! and the sparse Merkle tree of claimed receipt positions (the wallet's
//! nullifier history; the ledger stores no nullifiers). Losing this state
//! loses the funds, which is why the SDK encrypts and backs it up.
//!
//! Every state change goes through a two-phase journal: `prepare_*` records
//! the intended transition (including the new randomness) as `pending`
//! *before* the proof is submitted; `commit_pending` applies it once the
//! ledger has accepted; `abort_pending` drops it on rejection; and
//! [`Wallet::reconcile`] resolves an unknown outcome after a crash from the
//! ledger's current commitment alone. A send acknowledgement can therefore
//! never be lost between the network and local persistence.

use serde::{Deserialize, Serialize};
use zkpari::circuits::hasher::{hash, DOM_ACCT, DOM_REC};
use zkpari::circuits::merkle::MerklePath;
use zkpari::circuits::op::OpCircuit;
use zkpari::circuits::smt::SmtInsertion;
use zkpari::ZkPari;

use crate::account::{hex_32, Namespace, OpEnvelope, RegisterEnvelope, SpendKey};
use crate::deposit::DepositCircuit;
use crate::encoding::{fr_hex, fr_hex_vec, proof_to_bytes};
use crate::params::{Instance, Keys};
use crate::trees::{root_from_path, ClaimedSet, ReceiptOpening};
use crate::{Error, Fr, Result, E};

pub const WALLET_FORMAT_VERSION: u32 = 1;

/// A receipt this wallet holds the opening for (incoming funds), with its
/// claim status.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeldReceipt {
    /// Position in the receipt log (the nullifier).
    pub position: u64,
    #[serde(with = "fr_hex")]
    pub receipt: Fr,
    pub opening: ReceiptOpening,
    pub status: ReceiptStatus,
    /// Application reference (e.g. the payment request id), opaque here.
    pub reference: Option<String>,
    pub discovered_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReceiptStatus {
    /// Opening received; not yet checked against the ledger.
    Discovered,
    /// The commitment recomputed from the opening matches the leaf at
    /// `position` under an authenticated root.
    Verified,
    /// Verified and not yet claimed (spendable only after a receive).
    Unclaimed,
    Claiming,
    Claimed,
    /// The opening does not match the ledger, or the position is already in
    /// the claimed set.
    Invalid,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum PendingKind {
    Send {
        amount: u64,
        #[serde(with = "fr_hex")]
        to: Fr,
        /// The receipt opening to deliver to the receiver (encrypted, by
        /// the SDK) once the ledger accepts.
        opening: ReceiptOpening,
        reference: Option<String>,
    },
    Receive {
        position: u64,
        amount: u64,
    },
}

/// A prepared, not yet finalized transition.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingOp {
    pub kind: PendingKind,
    #[serde(with = "fr_hex")]
    pub com_old: Fr,
    #[serde(with = "fr_hex")]
    pub com_new: Fr,
    #[serde(with = "fr_hex")]
    pub r_new: Fr,
    #[serde(with = "fr_hex")]
    pub receipt_out: Fr,
    #[serde(with = "fr_hex")]
    pub root: Fr,
    /// Post-transition claimed set (receive only).
    pub claimed_after: Option<ClaimedSet>,
    /// The signed envelope, once proved; kept so a resubmission after a
    /// crash is byte-identical.
    pub envelope: Option<OpEnvelope>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub seq: u64,
    pub kind: String,
    pub amount: u64,
    #[serde(with = "fr_hex")]
    pub counterparty: Fr,
    pub position: Option<u64>,
    pub reference: Option<String>,
    pub at: u64,
}

/// The wallet. Serializes to JSON with `to_json`; the SDK encrypts that.
#[derive(Clone, Serialize, Deserialize)]
pub struct Wallet {
    pub version: u32,
    #[serde(with = "hex_32")]
    pub circuit_id: [u8; 32],
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "hex_32")]
    spend_seed: [u8; 32],
    #[serde(with = "fr_hex")]
    pub account: Fr,
    pub balance: u64,
    #[serde(with = "fr_hex")]
    pub randomness: Fr,
    pub claimed: ClaimedSet,
    pub registered: bool,
    pub pending: Option<PendingOp>,
    pub receipts: Vec<HeldReceipt>,
    pub history: Vec<HistoryEntry>,
    /// Monotonic local sequence for history entries.
    pub seq: u64,
    /// Roots this wallet has verified receipts against, most recent last.
    #[serde(with = "fr_hex_vec")]
    pub known_roots: Vec<Fr>,
    /// Deposit intents whose mint has not been observed yet. Persisted before
    /// the on-chain transfer is signed, so a lost response never costs a
    /// second deposit.
    pub pending_deposits: Vec<PendingDeposit>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingDeposit {
    #[serde(with = "fr_hex")]
    pub receipt: Fr,
    pub opening: ReceiptOpening,
    pub reference: Option<String>,
    pub created_at: u64,
}

/// The two things a wallet needs from the ledger to claim a receipt.
pub struct ReceiptWitness {
    pub path: MerklePath,
    pub root: Fr,
}

impl Wallet {
    pub fn create<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
        inst: &Instance,
        circuit_id: [u8; 32],
        namespace: Namespace,
        rng: &mut R,
    ) -> Self {
        let key = SpendKey::generate(rng);
        let account = key.account_id(&namespace);
        Self {
            version: WALLET_FORMAT_VERSION,
            circuit_id,
            namespace,
            spend_seed: key.seed(),
            account,
            balance: 0,
            randomness: random_fr(rng),
            claimed: ClaimedSet::new(&inst.hash, inst.null_depth),
            registered: false,
            pending: None,
            receipts: Vec::new(),
            history: Vec::new(),
            seq: 0,
            known_roots: Vec::new(),
            pending_deposits: Vec::new(),
        }
    }

    pub fn spend_key(&self) -> SpendKey {
        SpendKey::from_seed(&self.spend_seed)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("wallet serializes")
    }

    pub fn from_json(s: &str) -> Result<Self> {
        let w: Self = serde_json::from_str(s).map_err(|e| Error::Wallet(format!("parse: {e}")))?;
        if w.version != WALLET_FORMAT_VERSION {
            return Err(Error::Wallet(format!(
                "unsupported wallet format version {}",
                w.version
            )));
        }
        Ok(w)
    }

    /// The account's current commitment as the ledger holds it.
    pub fn commitment(&self, inst: &Instance) -> Fr {
        hash(
            &inst.hash,
            DOM_ACCT,
            &[Fr::from(self.balance), self.claimed.root(), self.randomness],
        )
    }

    /// Registration envelope: reveals `r_A` so the ledger can recompute the
    /// initial commitment. Only valid on a pristine wallet.
    pub fn register_envelope(&self) -> Result<RegisterEnvelope> {
        if self.registered || self.balance != 0 || !self.claimed.positions().is_empty() {
            return Err(Error::Wallet("only a pristine wallet can register".into()));
        }
        Ok(RegisterEnvelope::sign(
            &self.spend_key(),
            self.namespace,
            self.randomness,
        ))
    }

    fn require_idle(&self) -> Result<()> {
        if self.pending.is_some() {
            return Err(Error::Wallet(
                "an operation is pending; commit, abort or reconcile it first".into(),
            ));
        }
        Ok(())
    }

    /// Prepare a send of `amount` to `to`, revealing `root` as the anchor
    /// (any root in the ledger's window; a send does not use it). Returns
    /// the circuit to prove. The wallet is now `pending`.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_send<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
        &mut self,
        inst: &Instance,
        amount: u64,
        to: Fr,
        root: Fr,
        reference: Option<String>,
        now: u64,
        rng: &mut R,
    ) -> Result<OpCircuit> {
        self.require_idle()?;
        if !self.registered {
            return Err(Error::Wallet("account is not registered".into()));
        }
        if amount > self.balance {
            return Err(Error::Wallet(format!(
                "insufficient balance: {} < {amount}",
                self.balance
            )));
        }
        let r_new = random_fr(rng);
        let r_receipt = random_fr(rng);
        let mut circuit = OpCircuit {
            cfg: inst.hash.clone(),
            is_send: true,
            acct: self.account,
            b: self.balance,
            v: amount,
            r: self.randomness,
            r_new,
            root_null: self.claimed.root(),
            counterparty: to,
            r_receipt,
            r_dummy: Fr::from(0u64),
            root,
            pos: 0,
            path: MerklePath::empty(inst.receipt_depth),
            null_insert: SmtInsertion::placeholder(),
        };
        circuit.attach_dummy_insertion(inst.null_depth);
        let opening = ReceiptOpening {
            amount,
            sender: self.account,
            receiver: to,
            randomness: r_receipt,
        };
        debug_assert_eq!(circuit.com(), self.commitment(inst));
        self.pending = Some(PendingOp {
            kind: PendingKind::Send {
                amount,
                to,
                opening,
                reference,
            },
            com_old: circuit.com(),
            com_new: circuit.com_new(),
            r_new,
            receipt_out: circuit.receipt_out(),
            root,
            claimed_after: None,
            envelope: None,
            created_at: now,
        });
        Ok(circuit)
    }

    /// Check a held receipt against a served path and root: the commitment
    /// recomputed from the opening must be the leaf, and the leaf must sit
    /// under `root` at `position`. Marks it `Unclaimed` (or `Invalid`).
    pub fn verify_receipt(
        &mut self,
        inst: &Instance,
        idx: usize,
        witness: &ReceiptWitness,
    ) -> Result<bool> {
        let r = self
            .receipts
            .get(idx)
            .ok_or_else(|| Error::Wallet("no such receipt".into()))?
            .clone();
        let expected = receipt_commitment(inst, &r.opening);
        let ok = expected == r.receipt
            && r.opening.receiver == self.account
            && root_from_path(&inst.hash, r.receipt, &witness.path) == witness.root
            && !self.claimed.contains(r.position);
        let entry = &mut self.receipts[idx];
        entry.status = if ok {
            ReceiptStatus::Unclaimed
        } else {
            ReceiptStatus::Invalid
        };
        if ok && !self.known_roots.contains(&witness.root) {
            self.known_roots.push(witness.root);
        }
        Ok(ok)
    }

    /// Record an incoming receipt opening (from the inbox). Deduplicated by
    /// position.
    pub fn add_receipt(
        &mut self,
        inst: &Instance,
        position: u64,
        opening: ReceiptOpening,
        reference: Option<String>,
        now: u64,
    ) -> usize {
        if let Some(i) = self.receipts.iter().position(|r| r.position == position) {
            return i;
        }
        let receipt = receipt_commitment(inst, &opening);
        self.receipts.push(HeldReceipt {
            position,
            receipt,
            opening,
            status: ReceiptStatus::Discovered,
            reference,
            discovered_at: now,
        });
        self.receipts.len() - 1
    }

    /// Prepare the receive (claim) of held receipt `idx` against `witness`.
    pub fn prepare_receive<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
        &mut self,
        inst: &Instance,
        idx: usize,
        witness: &ReceiptWitness,
        now: u64,
        rng: &mut R,
    ) -> Result<OpCircuit> {
        self.require_idle()?;
        if !self.registered {
            return Err(Error::Wallet("account is not registered".into()));
        }
        let held = self
            .receipts
            .get(idx)
            .ok_or_else(|| Error::Wallet("no such receipt".into()))?
            .clone();
        if held.opening.receiver != self.account {
            return Err(Error::Wallet(
                "receipt is not addressed to this account".into(),
            ));
        }
        if receipt_commitment(inst, &held.opening) != held.receipt
            || root_from_path(&inst.hash, held.receipt, &witness.path) != witness.root
        {
            return Err(Error::Wallet(
                "receipt does not open under the given root".into(),
            ));
        }
        if held.position >= inst.max_positions() {
            return Err(Error::Wallet("position outside the log".into()));
        }
        self.balance
            .checked_add(held.opening.amount)
            .ok_or_else(|| Error::Wallet("balance would overflow".into()))?;
        let mut claimed_after = self.claimed.clone();
        let insertion = claimed_after.insert(&inst.hash, held.position)?;
        let r_new = random_fr(rng);
        let r_dummy = random_fr(rng);
        let circuit = OpCircuit {
            cfg: inst.hash.clone(),
            is_send: false,
            acct: self.account,
            b: self.balance,
            v: held.opening.amount,
            r: self.randomness,
            r_new,
            root_null: Fr::from(0u64),
            counterparty: held.opening.sender,
            r_receipt: held.opening.randomness,
            r_dummy,
            root: witness.root,
            pos: held.position,
            path: witness.path.clone(),
            null_insert: insertion,
        };
        debug_assert_eq!(circuit.com(), self.commitment(inst));
        debug_assert_eq!(circuit.receipt_in(), held.receipt);
        self.receipts[idx].status = ReceiptStatus::Claiming;
        self.pending = Some(PendingOp {
            kind: PendingKind::Receive {
                position: held.position,
                amount: held.opening.amount,
            },
            com_old: circuit.com(),
            com_new: circuit.com_new(),
            r_new,
            receipt_out: circuit.receipt_out(),
            root: witness.root,
            claimed_after: Some(claimed_after),
            envelope: None,
            created_at: now,
        });
        Ok(circuit)
    }

    /// Prove the pending operation and produce its signed envelope. The
    /// envelope is journaled so a crash after proving resubmits the same
    /// bytes rather than proving twice.
    pub fn prove_pending<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
        &mut self,
        keys: &Keys,
        circuit: OpCircuit,
        rng: &mut R,
    ) -> Result<OpEnvelope> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| Error::Wallet("nothing pending".into()))?;
        if keys.circuit_id != self.circuit_id {
            return Err(Error::Wallet("keys are for a different circuit".into()));
        }
        if circuit.com_new() != pending.com_new || circuit.receipt_out() != pending.receipt_out {
            return Err(Error::Wallet(
                "circuit does not match the pending operation".into(),
            ));
        }
        let proof = ZkPari::<E>::prove(circuit, &keys.op.pk, rng)
            .map_err(|e| Error::Wallet(format!("proving failed: {e:?}")))?;
        let env = OpEnvelope::sign(
            &self.spend_key(),
            self.namespace,
            self.circuit_id,
            self.account,
            pending.com_old,
            pending.com_new,
            pending.receipt_out,
            pending.root,
            proof_to_bytes(&proof),
        );
        self.pending.as_mut().expect("checked").envelope = Some(env.clone());
        Ok(env)
    }

    /// The ledger accepted the pending operation at `position`.
    pub fn commit_pending(&mut self, position: u64, now: u64) -> Result<()> {
        let p = self
            .pending
            .take()
            .ok_or_else(|| Error::Wallet("nothing pending".into()))?;
        self.seq += 1;
        match p.kind {
            PendingKind::Send {
                amount,
                to,
                reference,
                ..
            } => {
                self.balance -= amount;
                self.history.push(HistoryEntry {
                    seq: self.seq,
                    kind: "send".into(),
                    amount,
                    counterparty: to,
                    position: Some(position),
                    reference,
                    at: now,
                });
            }
            PendingKind::Receive {
                position: claimed_pos,
                amount,
            } => {
                self.balance += amount;
                self.claimed = p.claimed_after.expect("receive carries the new set");
                let mut counterparty = Fr::from(0u64);
                let mut reference = None;
                if let Some(r) = self.receipts.iter_mut().find(|r| r.position == claimed_pos) {
                    r.status = ReceiptStatus::Claimed;
                    counterparty = r.opening.sender;
                    reference = r.reference.clone();
                }
                self.history.push(HistoryEntry {
                    seq: self.seq,
                    kind: "receive".into(),
                    amount,
                    counterparty,
                    position: Some(claimed_pos),
                    reference,
                    at: now,
                });
            }
        }
        self.randomness = p.r_new;
        Ok(())
    }

    /// The ledger rejected the pending operation (or it was never sent).
    pub fn abort_pending(&mut self) {
        if let Some(PendingOp {
            kind: PendingKind::Receive { position, .. },
            ..
        }) = &self.pending
        {
            let position = *position;
            if let Some(r) = self.receipts.iter_mut().find(|r| r.position == position) {
                r.status = ReceiptStatus::Unclaimed;
            }
        }
        self.pending = None;
    }

    /// Resolve an unknown outcome from the ledger's current commitment for
    /// this account. `position` is the receipt position the ledger reports
    /// for the accepted op, if it did accept it.
    pub fn reconcile(
        &mut self,
        inst: &Instance,
        ledger_com: Fr,
        position: Option<u64>,
        now: u64,
    ) -> Result<Reconciled> {
        let Some(p) = &self.pending else {
            return Ok(if ledger_com == self.commitment(inst) {
                Reconciled::InSync
            } else {
                Reconciled::Conflict
            });
        };
        if ledger_com == p.com_new {
            let pos =
                position.ok_or_else(|| Error::Wallet("accepted op needs its position".into()))?;
            self.commit_pending(pos, now)?;
            Ok(Reconciled::Committed)
        } else if ledger_com == p.com_old {
            self.abort_pending();
            Ok(Reconciled::Aborted)
        } else {
            Ok(Reconciled::Conflict)
        }
    }

    /// Build a deposit intent for `amount` into this account: a fresh mint
    /// receipt opening (kept locally, so the mint can be claimed) and the
    /// R_dep proof that the receipt commits to `amount`.
    pub fn prepare_deposit<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
        &mut self,
        inst: &Instance,
        keys: &Keys,
        amount: u64,
        reference: Option<String>,
        now: u64,
        rng: &mut R,
    ) -> Result<(crate::deposit::DepositIntent, ReceiptOpening)> {
        if keys.circuit_id != self.circuit_id {
            return Err(Error::Wallet("keys are for a different circuit".into()));
        }
        let opening = ReceiptOpening {
            amount,
            sender: crate::deposit::mint_sender(),
            receiver: self.account,
            randomness: random_fr(rng),
        };
        let circuit = DepositCircuit::from_opening(inst, &opening);
        let receipt = circuit.receipt();
        let proof = ZkPari::<E>::prove(circuit, &keys.deposit.pk, rng)
            .map_err(|e| Error::Wallet(format!("deposit proving failed: {e:?}")))?;
        let intent = crate::deposit::DepositIntent {
            namespace: self.namespace,
            circuit_id: self.circuit_id,
            amount,
            receipt,
            proof: proof_to_bytes(&proof),
        };
        self.pending_deposits.push(PendingDeposit {
            receipt,
            opening: opening.clone(),
            reference,
            created_at: now,
        });
        Ok((intent, opening))
    }

    /// The ledger minted the deposit with receipt `receipt` at `position`:
    /// move it from pending deposits to held receipts.
    pub fn deposit_minted(
        &mut self,
        inst: &Instance,
        receipt: Fr,
        position: u64,
        now: u64,
    ) -> Option<usize> {
        let idx = self
            .pending_deposits
            .iter()
            .position(|d| d.receipt == receipt)?;
        let d = self.pending_deposits.remove(idx);
        Some(self.add_receipt(inst, position, d.opening, d.reference, now))
    }

    /// Spendable balance and the verified-but-unclaimed incoming total.
    pub fn balances(&self) -> (u64, u64) {
        let unclaimed = self
            .receipts
            .iter()
            .filter(|r| matches!(r.status, ReceiptStatus::Unclaimed | ReceiptStatus::Claiming))
            .map(|r| r.opening.amount)
            .fold(0u64, |a, b| a.saturating_add(b));
        (self.balance, unclaimed)
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Reconciled {
    InSync,
    Committed,
    Aborted,
    /// The ledger's commitment is neither the old nor the new one: this
    /// wallet state is stale relative to another device. Restore from the
    /// newer backup.
    Conflict,
}

/// `Com_rec(v, Sen, Rec, 1; r'')`: a real (type-1) receipt.
pub fn receipt_commitment(inst: &Instance, o: &ReceiptOpening) -> Fr {
    hash(
        &inst.hash,
        DOM_REC,
        &[
            Fr::from(o.amount),
            o.sender,
            o.receiver,
            Fr::from(1u64),
            o.randomness,
        ],
    )
}

pub fn random_fr<R: ark_std::rand::RngCore>(rng: &mut R) -> Fr {
    use ark_ff::UniformRand;
    Fr::rand(rng)
}

//! The Peal Links wallet in the browser.
//!
//! Everything private happens here, inside wasm memory: the spend key, the
//! account opening, the claimed-position tree, receipt openings, proving.
//! The JavaScript side moves opaque JSON and bytes between this module, the
//! node API and IndexedDB. Nothing in this file talks to the network.
//!
//! Single-threaded on purpose (docs/peal-links/decisions/0006): the host
//! does not serve cross-origin isolation headers, so there are no wasm
//! threads. The SDK runs this module inside a Web Worker so proving never
//! blocks the page.

use peal_bonsai::account::InboxAuth;
use peal_bonsai::encoding::{fr_from_hex, fr_to_hex};
use peal_bonsai::envelope::{
    open_backup, open_receipt, open_with_key, seal_backup, seal_receipt, seal_with_key,
};
use peal_bonsai::manifest::{new_request_id, FulfillmentAck, RequestManifest};
use peal_bonsai::params::{pk_from_bytes_with, vk_from_bytes, CircuitKeys, Instance, Keys};
use peal_bonsai::trees::ReceiptOpening;
use peal_bonsai::wallet::{ReceiptWitness, Wallet};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zkpari::circuits::merkle::MerklePath;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn now() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The fixed instantiation plus loaded keys. Building the instance runs the
/// Poseidon parameter generation once (about a second in wasm), so the SDK
/// keeps one `Prover` per worker.
#[wasm_bindgen]
pub struct Prover {
    inst: Instance,
    keys: Option<Keys>,
}

#[derive(Serialize)]
struct KeyInfo {
    circuit_id: String,
    op_vk_digest: String,
    deposit_vk_digest: String,
}

#[wasm_bindgen]
impl Prover {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Prover {
        Prover {
            inst: Instance::default_instance(),
            keys: None,
        }
    }

    /// Load the four parameter files (downloaded by digest). Verifying keys
    /// are point-validated; proving keys are trusted by digest (see
    /// `pk_from_bytes_with`). The circuit id is recomputed and must match
    /// `expected`.
    pub fn load_keys(
        &mut self,
        op_pk: &[u8],
        op_vk: &[u8],
        deposit_pk: &[u8],
        deposit_vk: &[u8],
        expected_circuit_id: &str,
    ) -> Result<JsValue, JsError> {
        let op = CircuitKeys::from_parts(
            pk_from_bytes_with(op_pk, false).map_err(err)?,
            vk_from_bytes(op_vk).map_err(err)?,
        );
        let deposit = CircuitKeys::from_parts(
            pk_from_bytes_with(deposit_pk, false).map_err(err)?,
            vk_from_bytes(deposit_vk).map_err(err)?,
        );
        let keys = Keys::from_circuits(&self.inst, op, deposit);
        if hex::encode(keys.circuit_id) != expected_circuit_id {
            return Err(JsError::new(
                "parameter files do not match the node's circuit id",
            ));
        }
        let info = KeyInfo {
            circuit_id: hex::encode(keys.circuit_id),
            op_vk_digest: hex::encode(keys.op.vk_digest),
            deposit_vk_digest: hex::encode(keys.deposit.vk_digest),
        };
        self.keys = Some(keys);
        serde_wasm_bindgen::to_value(&info).map_err(err)
    }

    pub fn has_keys(&self) -> bool {
        self.keys.is_some()
    }

    fn keys(&self) -> Result<&Keys, JsError> {
        self.keys
            .as_ref()
            .ok_or_else(|| JsError::new("proving keys not loaded"))
    }

    // ---- wallet lifecycle ------------------------------------------------

    /// A fresh wallet for `namespace` (hex) under `circuit_id` (hex). Returns
    /// the wallet JSON; the SDK encrypts it before storing.
    pub fn create_wallet(&self, namespace: &str, circuit_id: &str) -> Result<String, JsError> {
        let ns = parse32(namespace)?;
        let cid = parse32(circuit_id)?;
        let mut rng = peal_bonsai::os_rng();
        Ok(Wallet::create(&self.inst, cid, ns, &mut rng).to_json())
    }

    /// Public facts about a wallet: account id, encryption key, balances,
    /// receipts, history, pending state. No secrets.
    pub fn wallet_view(&self, wallet_json: &str) -> Result<JsValue, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_wasm_bindgen::to_value(&WalletView::from(&self.inst, &w)).map_err(err)
    }

    pub fn register_envelope(&self, wallet_json: &str) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_json::to_string(&w.register_envelope().map_err(err)?).map_err(err)
    }

    /// Mark the wallet registered (after the ledger accepted the envelope).
    pub fn mark_registered(&self, wallet_json: &str) -> Result<String, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        w.registered = true;
        Ok(w.to_json())
    }

    pub fn key_binding(&self, wallet_json: &str, seq: u64) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_json::to_string(&w.key_binding(seq)).map_err(err)
    }

    pub fn inbox_auth(&self, wallet_json: &str) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_json::to_string(&InboxAuth::sign(&w.spend_key(), w.namespace, now())).map_err(err)
    }

    // ---- deposits ----------------------------------------------------------

    /// Prepare a deposit intent: returns `{ wallet, intent }`. The wallet JSON
    /// must be persisted before the on-chain transfer is signed.
    pub fn prepare_deposit(
        &self,
        wallet_json: &str,
        amount: &str,
        reference: Option<String>,
    ) -> Result<JsValue, JsError> {
        let keys = self.keys()?;
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let amount = parse_amount(amount)?;
        let mut rng = peal_bonsai::os_rng();
        let (intent, _opening) = w
            .prepare_deposit(&self.inst, keys, amount, reference, now(), &mut rng)
            .map_err(err)?;
        to_js(&WalletAnd {
            wallet: w.to_json(),
            value: intent,
        })
    }

    /// The ledger minted the intent's receipt at `position`.
    pub fn deposit_minted(
        &self,
        wallet_json: &str,
        receipt: &str,
        position: u64,
    ) -> Result<String, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let r = fr_from_hex(receipt).map_err(err)?;
        w.deposit_minted(&self.inst, r, position, now())
            .ok_or_else(|| JsError::new("no pending deposit with that receipt"))?;
        Ok(w.to_json())
    }

    // ---- receipts ----------------------------------------------------------

    /// Record an incoming receipt opening (decrypted from the inbox).
    pub fn add_receipt(
        &self,
        wallet_json: &str,
        position: u64,
        opening_json: &str,
        reference: Option<String>,
    ) -> Result<String, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let opening: ReceiptOpening = serde_json::from_str(opening_json).map_err(err)?;
        w.add_receipt(&self.inst, position, opening, reference, now());
        Ok(w.to_json())
    }

    /// Verify held receipt `idx` against a served path. Returns the updated
    /// wallet JSON; the receipt's status becomes `Unclaimed` or `Invalid`.
    pub fn verify_receipt(
        &self,
        wallet_json: &str,
        idx: usize,
        path_json: &str,
    ) -> Result<JsValue, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let witness = parse_witness(path_json)?;
        let ok = w.verify_receipt(&self.inst, idx, &witness).map_err(err)?;
        to_js(&WalletAnd {
            wallet: w.to_json(),
            value: ok,
        })
    }

    // ---- operations --------------------------------------------------------

    /// Prepare and prove a send. Returns `{ wallet, envelope, opening }`; the
    /// wallet is now pending and must be persisted before submission.
    pub fn send(
        &self,
        wallet_json: &str,
        amount: &str,
        to: &str,
        root: &str,
        reference: Option<String>,
    ) -> Result<JsValue, JsError> {
        let keys = self.keys()?;
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let amount = parse_amount(amount)?;
        let to = fr_from_hex(to).map_err(err)?;
        let root = fr_from_hex(root).map_err(err)?;
        let mut rng = peal_bonsai::os_rng();
        let circuit = w
            .prepare_send(&self.inst, amount, to, root, reference, now(), &mut rng)
            .map_err(err)?;
        let opening = match &w.pending.as_ref().expect("prepared").kind {
            peal_bonsai::wallet::PendingKind::Send { opening, .. } => opening.clone(),
            _ => unreachable!(),
        };
        let envelope = w.prove_pending(keys, circuit, &mut rng).map_err(err)?;
        to_js(&SendOut {
            wallet: w.to_json(),
            envelope,
            opening,
        })
    }

    /// Prepare and prove a withdrawal of `amount` to the EVM `recipient`: a
    /// send to the burn identifier. Returns `{ wallet, envelope, opening }`.
    pub fn withdraw(
        &self,
        wallet_json: &str,
        amount: &str,
        recipient: &str,
        root: &str,
    ) -> Result<JsValue, JsError> {
        let keys = self.keys()?;
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let amount = parse_amount(amount)?;
        let root = fr_from_hex(root).map_err(err)?;
        let mut rng = peal_bonsai::os_rng();
        let circuit = w
            .prepare_withdrawal(&self.inst, amount, root, recipient, now(), &mut rng)
            .map_err(err)?;
        let opening = match &w.pending.as_ref().expect("prepared").kind {
            peal_bonsai::wallet::PendingKind::Send { opening, .. } => opening.clone(),
            _ => unreachable!(),
        };
        let envelope = w.prove_pending(keys, circuit, &mut rng).map_err(err)?;
        to_js(&SendOut {
            wallet: w.to_json(),
            envelope,
            opening,
        })
    }

    /// The signed disclosure for the withdrawal committed at `position`.
    pub fn withdrawal_claim(&self, wallet_json: &str, position: u64) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_json::to_string(&w.withdrawal_claim(position).map_err(err)?).map_err(err)
    }

    /// Prepare and prove the claim of held receipt `idx`.
    pub fn receive(
        &self,
        wallet_json: &str,
        idx: usize,
        path_json: &str,
    ) -> Result<JsValue, JsError> {
        let keys = self.keys()?;
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let witness = parse_witness(path_json)?;
        let mut rng = peal_bonsai::os_rng();
        let circuit = w
            .prepare_receive(&self.inst, idx, &witness, now(), &mut rng)
            .map_err(err)?;
        let envelope = w.prove_pending(keys, circuit, &mut rng).map_err(err)?;
        to_js(&WalletAnd {
            wallet: w.to_json(),
            value: envelope,
        })
    }

    pub fn commit_pending(&self, wallet_json: &str, position: u64) -> Result<String, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        w.commit_pending(position, now()).map_err(err)?;
        Ok(w.to_json())
    }

    pub fn abort_pending(&self, wallet_json: &str) -> Result<String, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        w.abort_pending();
        Ok(w.to_json())
    }

    /// Resolve an unknown outcome from the ledger's commitment. Returns
    /// `{ wallet, value: "in_sync" | "committed" | "aborted" | "conflict" }`.
    pub fn reconcile(
        &self,
        wallet_json: &str,
        ledger_com: &str,
        position: Option<u64>,
    ) -> Result<JsValue, JsError> {
        let mut w = Wallet::from_json(wallet_json).map_err(err)?;
        let com = fr_from_hex(ledger_com).map_err(err)?;
        let r = w.reconcile(&self.inst, com, position, now()).map_err(err)?;
        let label = match r {
            peal_bonsai::wallet::Reconciled::InSync => "in_sync",
            peal_bonsai::wallet::Reconciled::Committed => "committed",
            peal_bonsai::wallet::Reconciled::Aborted => "aborted",
            peal_bonsai::wallet::Reconciled::Conflict => "conflict",
        };
        to_js(&WalletAnd {
            wallet: w.to_json(),
            value: label,
        })
    }

    /// The wallet's current commitment (to compare with the ledger's).
    pub fn commitment(&self, wallet_json: &str) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        Ok(fr_to_hex(&w.commitment(&self.inst)))
    }

    // ---- requests ----------------------------------------------------------

    pub fn new_request_id(&self) -> String {
        new_request_id(&mut peal_bonsai::os_rng())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn sign_request(
        &self,
        wallet_json: &str,
        request_id: &str,
        amount: &str,
        title: &str,
        display_name: &str,
        receiver_address: &str,
        reference: Option<String>,
        expires_at: Option<u64>,
    ) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        let m = RequestManifest::sign(
            &w.spend_key(),
            w.namespace,
            w.encryption_key().public(),
            request_id.to_string(),
            parse_amount(amount)?,
            title.to_string(),
            display_name.to_string(),
            receiver_address.to_string(),
            reference,
            expires_at,
            now(),
        )
        .map_err(err)?;
        serde_json::to_string(&m).map_err(err)
    }

    /// Verify a manifest a payer received. Errors describe why it is not
    /// trustworthy.
    pub fn verify_request(&self, manifest_json: &str) -> Result<(), JsError> {
        let m: RequestManifest = serde_json::from_str(manifest_json).map_err(err)?;
        m.verify().map_err(err)
    }

    pub fn fulfillment_ack(
        &self,
        wallet_json: &str,
        request_id: &str,
        position: u64,
    ) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        serde_json::to_string(&FulfillmentAck::sign(
            &w.spend_key(),
            w.namespace,
            request_id.to_string(),
            position,
            now(),
        ))
        .map_err(err)
    }

    // ---- envelopes and backups ---------------------------------------------

    /// Seal a receipt opening (plus position and reference) to a recipient's
    /// encryption key. Returns the envelope JSON to post to the inbox.
    pub fn seal_receipt(
        &self,
        namespace: &str,
        recipient_enc_key: &str,
        opening_json: &str,
        position: u64,
        reference: Option<String>,
    ) -> Result<String, JsError> {
        let ns = parse32(namespace)?;
        let recipient = parse32(recipient_enc_key)?;
        let opening: ReceiptOpening = serde_json::from_str(opening_json).map_err(err)?;
        let payload = Delivery {
            opening,
            position,
            reference,
        };
        let bytes = serde_json::to_vec(&payload).map_err(err)?;
        let mut rng = peal_bonsai::os_rng();
        let env = seal_receipt(ns, recipient, &bytes, &mut rng).map_err(err)?;
        serde_json::to_string(&env).map_err(err)
    }

    /// Open an inbox envelope with the wallet's key. Returns the delivery
    /// JSON `{ opening, position, reference }`.
    pub fn open_receipt(&self, wallet_json: &str, envelope_json: &str) -> Result<String, JsError> {
        let w = Wallet::from_json(wallet_json).map_err(err)?;
        let env = serde_json::from_str(envelope_json).map_err(err)?;
        let bytes = open_receipt(&w.encryption_key(), &w.namespace, &env).map_err(err)?;
        let d: Delivery = serde_json::from_slice(&bytes).map_err(err)?;
        serde_json::to_string(&d).map_err(err)
    }

    pub fn export_backup(&self, wallet_json: &str, passphrase: &str) -> Result<String, JsError> {
        Wallet::from_json(wallet_json).map_err(err)?; // must be a valid wallet
        let mut rng = peal_bonsai::os_rng();
        let b = seal_backup(passphrase, wallet_json.as_bytes(), &mut rng).map_err(err)?;
        serde_json::to_string(&b).map_err(err)
    }

    pub fn import_backup(&self, backup_json: &str, passphrase: &str) -> Result<String, JsError> {
        let b = serde_json::from_str(backup_json).map_err(err)?;
        let bytes = open_backup(passphrase, &b).map_err(err)?;
        let json = String::from_utf8(bytes).map_err(err)?;
        let w = Wallet::from_json(&json).map_err(err)?;
        Ok(w.to_json())
    }

    /// A fresh random storage key (hex). Wrapped with the passphrase by
    /// `wrap_key`; used by `lock_wallet` on every save.
    pub fn new_storage_key(&self) -> String {
        let mut k = [0u8; 32];
        peal_bonsai::rand::RngCore::fill_bytes(&mut peal_bonsai::os_rng(), &mut k);
        hex::encode(k)
    }

    /// Wrap the storage key under a passphrase (argon2id, once per setup).
    pub fn wrap_key(&self, key_hex: &str, passphrase: &str) -> Result<String, JsError> {
        let key = parse32(key_hex)?;
        let mut rng = peal_bonsai::os_rng();
        serde_json::to_string(&seal_backup(passphrase, &key, &mut rng).map_err(err)?).map_err(err)
    }

    pub fn unwrap_key(&self, wrapped_json: &str, passphrase: &str) -> Result<String, JsError> {
        let b = serde_json::from_str(wrapped_json).map_err(err)?;
        let key = open_backup(passphrase, &b).map_err(err)?;
        if key.len() != 32 {
            return Err(JsError::new("wrapped key has the wrong length"));
        }
        Ok(hex::encode(key))
    }

    /// Encrypt the wallet for local storage under the storage key (cheap;
    /// runs on every state change).
    pub fn lock_wallet(&self, wallet_json: &str, key_hex: &str) -> Result<String, JsError> {
        Wallet::from_json(wallet_json).map_err(err)?;
        let key = parse32(key_hex)?;
        let mut rng = peal_bonsai::os_rng();
        serde_json::to_string(&seal_with_key(&key, wallet_json.as_bytes(), &mut rng).map_err(err)?)
            .map_err(err)
    }

    pub fn unlock_wallet(&self, locked_json: &str, key_hex: &str) -> Result<String, JsError> {
        let key = parse32(key_hex)?;
        let s = serde_json::from_str(locked_json).map_err(err)?;
        let bytes = open_with_key(&key, &s).map_err(err)?;
        let json = String::from_utf8(bytes).map_err(err)?;
        Wallet::from_json(&json).map_err(err)?;
        Ok(json)
    }
}

impl Default for Prover {
    fn default() -> Self {
        Self::new()
    }
}

// ---- helpers ------------------------------------------------------------

fn parse32(hex_str: &str) -> Result<[u8; 32], JsError> {
    let v = hex::decode(hex_str).map_err(err)?;
    v.try_into().map_err(|_| JsError::new("expected 32 bytes"))
}

fn parse_amount(s: &str) -> Result<u64, JsError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(JsError::new(
            "amount must be a decimal integer string of base units",
        ));
    }
    s.parse::<u64>()
        .map_err(|_| JsError::new("amount exceeds 2^64"))
}

#[derive(Deserialize)]
struct PathIn {
    root: String,
    siblings: Vec<String>,
    index_bits: Vec<bool>,
}

fn parse_witness(path_json: &str) -> Result<ReceiptWitness, JsError> {
    let p: PathIn = serde_json::from_str(path_json).map_err(err)?;
    let siblings = p
        .siblings
        .iter()
        .map(|s| fr_from_hex(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if siblings.len() != p.index_bits.len() {
        return Err(JsError::new("path siblings and bits differ in length"));
    }
    Ok(ReceiptWitness {
        path: MerklePath {
            siblings,
            index_bits: p.index_bits,
        },
        root: fr_from_hex(&p.root).map_err(err)?,
    })
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(v).map_err(err)
}

#[derive(Serialize)]
struct WalletAnd<T: Serialize> {
    wallet: String,
    value: T,
}

#[derive(Serialize)]
struct SendOut {
    wallet: String,
    envelope: peal_bonsai::account::OpEnvelope,
    opening: ReceiptOpening,
}

/// What travels inside a receipt envelope.
#[derive(Serialize, Deserialize)]
struct Delivery {
    opening: ReceiptOpening,
    position: u64,
    reference: Option<String>,
}

#[derive(Serialize)]
struct ReceiptView {
    position: u64,
    receipt: String,
    amount: String,
    sender: String,
    status: String,
    reference: Option<String>,
    discovered_at: u64,
}

#[derive(Serialize)]
struct HistoryView {
    seq: u64,
    kind: String,
    amount: String,
    counterparty: String,
    position: Option<u64>,
    reference: Option<String>,
    at: u64,
}

#[derive(Serialize)]
struct WalletView {
    namespace: String,
    circuit_id: String,
    account: String,
    enc_pubkey: String,
    registered: bool,
    balance: String,
    unclaimed: String,
    pending: Option<String>,
    pending_deposits: Vec<String>,
    receipts: Vec<ReceiptView>,
    history: Vec<HistoryView>,
    commitment: String,
}

impl WalletView {
    fn from(inst: &Instance, w: &Wallet) -> Self {
        let (balance, unclaimed) = w.balances();
        Self {
            namespace: hex::encode(w.namespace),
            circuit_id: hex::encode(w.circuit_id),
            account: fr_to_hex(&w.account),
            enc_pubkey: hex::encode(w.encryption_key().public()),
            registered: w.registered,
            balance: balance.to_string(),
            unclaimed: unclaimed.to_string(),
            pending: w.pending.as_ref().map(|p| match &p.kind {
                peal_bonsai::wallet::PendingKind::Send { .. } => "send".to_string(),
                peal_bonsai::wallet::PendingKind::Receive { .. } => "receive".to_string(),
            }),
            pending_deposits: w
                .pending_deposits
                .iter()
                .map(|d| fr_to_hex(&d.receipt))
                .collect(),
            receipts: w
                .receipts
                .iter()
                .map(|r| ReceiptView {
                    position: r.position,
                    receipt: fr_to_hex(&r.receipt),
                    amount: r.opening.amount.to_string(),
                    sender: fr_to_hex(&r.opening.sender),
                    status: format!("{:?}", r.status).to_lowercase(),
                    reference: r.reference.clone(),
                    discovered_at: r.discovered_at,
                })
                .collect(),
            history: w
                .history
                .iter()
                .map(|h| HistoryView {
                    seq: h.seq,
                    kind: h.kind.clone(),
                    amount: h.amount.to_string(),
                    counterparty: fr_to_hex(&h.counterparty),
                    position: h.position,
                    reference: h.reference.clone(),
                    at: h.at,
                })
                .collect(),
            commitment: fr_to_hex(&w.commitment(inst)),
        }
    }
}

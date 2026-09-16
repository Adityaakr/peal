//! Peal Links consensus: Commonware `simplex` ordering blocks of ledger
//! envelopes over the deterministic Bonsai ledger state transition.
//!
//! Shape (decision 0010):
//! - A **block** is a list of transactions (register, operation, mint
//!   envelopes, each tagged with its namespace) over a parent digest. Its
//!   digest is the SHA-256 of its exact bytes, which is what the engine
//!   orders and what the validators sign.
//! - **Verification** (voting) is stateless: structure, parent, view,
//!   signatures, proofs against the commitment each envelope claims, and,
//!   for mints, that this validator's own chain view confirms the deposit.
//! - **Application** happens at finalization, in order, on every
//!   validator, through the same `Ledger` code the single-node mode uses.
//!   Operations that fail stateful checks (stale commitment, root not
//!   recent, duplicate deposit) are skipped deterministically and their
//!   submitters are told so.
//! - Block bytes travel on a dedicated p2p channel; a validator that
//!   misses a block asks its peers for it by digest (a small backfill in
//!   place of `marshal`).
//! - The validator set is static for an epoch and the signing scheme is
//!   ed25519 with 2f+1 quorums, so three validators tolerate none and four
//!   tolerate one fault.

pub mod actor;
pub mod block;
pub mod engine;
pub mod sim;
pub mod state;
pub mod validator;
pub mod wire;

pub use actor::{AppHandler, DepositOracle, Handle, Status};
pub use block::{genesis, Block, Envelope, Id, Tx};
pub use commonware_cryptography::ed25519::{PrivateKey, PublicKey};
pub use state::{Head, LedgerSummary, ReceiptPath, Shared, State};

use commonware_codec::DecodeExt;

/// Decode an ed25519 public key from its 32-byte hex form.
pub fn public_key_from_hex(s: &str) -> anyhow::Result<PublicKey> {
    let raw = hex::decode(s.trim_start_matches("0x"))?;
    PublicKey::decode(&raw[..]).map_err(|e| anyhow::anyhow!("validator key: {e}"))
}

/// Decode an ed25519 private key from its 32-byte hex seed.
pub fn private_key_from_hex(s: &str) -> anyhow::Result<PrivateKey> {
    let raw = hex::decode(s.trim())?;
    PrivateKey::decode(&raw[..]).map_err(|e| anyhow::anyhow!("private key: {e}"))
}

/// A fresh ed25519 private key from OS randomness, as a hex seed.
pub fn generate_private_key_hex() -> String {
    use ark_std::rand::RngCore;
    let mut seed = [0u8; 32];
    peal_bonsai::os_rng().fill_bytes(&mut seed);
    hex::encode(seed)
}

//! peal-bonsai: the Bonsai private-payment core for Peal Links.
//!
//! Everything cryptographic that Peal Links does with value goes through this
//! crate, and every proof it makes or checks is produced and verified by the
//! pinned upstream ZK-Pari implementation (`zkpari`, git revision recorded in
//! the workspace `Cargo.toml` and in `docs/peal-links/RESEARCH.md`). This crate
//! adds what the prototype leaves to an integrator:
//!
//! - [`params`]: one fixed instantiation (Poseidon, tree depths, circuit id),
//!   key generation, and key persistence with digests.
//! - [`encoding`]: canonical wire encodings that reject non-canonical field
//!   elements and off-curve or off-subgroup points before any pairing runs.
//! - [`trees`]: the persistent receipt tree and the wallet's sparse Merkle
//!   tree of claimed positions, hash-for-hash compatible with the upstream
//!   test trees (parity-tested).
//! - [`account`]: account identity, namespace binding and signed envelopes.
//! - [`wallet`]: the private state a client holds (openings, nullifier tree,
//!   journal) and witness construction for send and receive.
//! - [`ledger`] (feature `ledger`): the deterministic state transition
//!   function over a durable sqlite store, with the recent-root policy and
//!   the verifier path.
//!
//! Money is `u64` base units everywhere. Nothing in here is a mock: there is
//! no path that accepts an operation without a proof that verifies under the
//! circuit's verifying key.

pub mod account;
pub mod deposit;
pub mod encoding;
pub mod params;
pub mod trees;
pub mod wallet;

#[cfg(feature = "ledger")]
pub mod ledger;

/// Re-export of the rand version the arkworks stack (and therefore zkpari)
/// is built against, so RNG trait versions never diverge downstream.
pub use ark_std::rand;

pub use ark_bls12_381::Bls12_381 as E;
pub use zkpari::circuits::Fr;

/// OS-entropy RNG (native and wasm; getrandom picks the platform source).
pub fn os_rng() -> rand_chacha::ChaCha20Rng {
    use rand::SeedableRng;
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("OS entropy unavailable");
    rand_chacha::ChaCha20Rng::from_seed(seed)
}

#[derive(Debug, thiserror::Error, PartialEq, Eq, Clone)]
pub enum Error {
    #[error("wire format error: {0}")]
    Wire(String),
    #[error("non-canonical field element")]
    NonCanonicalField,
    #[error("invalid group element (off curve or off subgroup)")]
    InvalidPoint,
    #[error("proof does not verify")]
    InvalidProof,
    #[error("account is not registered")]
    UnknownAccount,
    #[error("account is already registered")]
    AccountExists,
    #[error("stale account commitment: the account moved since this proof was made")]
    StaleCommitment,
    #[error("revealed receipt root is not within the recent-root window")]
    RootNotRecent,
    #[error("receipt log is full")]
    ReceiptLogFull,
    #[error("wrong namespace")]
    WrongNamespace,
    #[error("bad signature")]
    BadSignature,
    #[error("wallet state error: {0}")]
    Wallet(String),
    #[error("storage error: {0}")]
    Storage(String),
}

pub type Result<T> = std::result::Result<T, Error>;

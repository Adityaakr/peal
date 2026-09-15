//! Deposits: how value enters a namespace, and the relation that keeps the
//! gateway from learning which account it went to.
//!
//! Bonsai has no deposit; this is Peal's extension. A deposit of `v` base
//! units into the gateway is credited by appending a *mint receipt*
//! `rho = Com_rec(v, MINT, A, 1; r'')` to the receipt log, exactly the shape
//! a sent receipt has, so the owner of `A` claims it with the ordinary
//! receive branch of R_op. `MINT` is a fixed identifier no key derives, so a
//! mint receipt can never be mistaken for a payment from a real account.
//!
//! The ledger must not append a receipt it cannot see inside: a depositor who
//! could commit to `v' > v` would claim more than they put in. So the
//! depositor proves, in zero knowledge, that `rho` opens to the publicly
//! observed amount:
//!
//!   R_dep:  x = (v, rho),  w = (A, r'')
//!           rho = Com_rec(v, MINT, A, 1; r'')  and  v in [0, 2^64)
//!
//! The gateway and the watcher see `v` and `rho`; only the depositor knows
//! `A`. The proof is made before the on-chain transaction and registered with
//! the ledger as a *deposit intent* (docs/peal-links/decisions/0004), so the
//! irreversible step never happens without the credit path already in place.
//!
//! Cost: one Poseidon hash and one 64-bit range check (~400 R1CS), so this
//! is a sub-second proof anywhere, including single-threaded wasm.

use ark_r1cs_std::alloc::AllocVar;
use ark_r1cs_std::eq::EqGadget;
use ark_r1cs_std::fields::fp::FpVar;
use ark_relations::gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use serde::{Deserialize, Serialize};
use zkpari::circuits::enforce_range_64;
use zkpari::circuits::hasher::{hash, hash_var, HashCfg, DOM_REC};

use crate::account::{hex_32, hex_vec, Namespace};
use crate::encoding::fr_hex;
use crate::params::Instance;
use crate::trees::ReceiptOpening;
use crate::Fr;

/// The sender identifier carried by every mint receipt. Chosen as a fixed
/// field element outside the image of `account_id` with overwhelming
/// probability (it is the little-endian reading of a tagged sha256).
pub fn mint_sender() -> Fr {
    use ark_ff::PrimeField;
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(b"peal-links/v1/mint-sender");
    Fr::from_le_bytes_mod_order(&d)
}

#[derive(Clone)]
pub struct DepositCircuit {
    pub cfg: HashCfg,
    /// Public: amount and the receipt commitment.
    pub amount: u64,
    /// Witness: the destination account and the receipt randomness.
    pub account: Fr,
    pub randomness: Fr,
}

impl DepositCircuit {
    pub fn blank(inst: &Instance) -> Self {
        Self {
            cfg: inst.hash.clone(),
            amount: 1,
            account: Fr::from(0u64),
            randomness: Fr::from(0u64),
        }
    }

    pub fn from_opening(inst: &Instance, o: &ReceiptOpening) -> Self {
        debug_assert_eq!(o.sender, mint_sender());
        Self {
            cfg: inst.hash.clone(),
            amount: o.amount,
            account: o.receiver,
            randomness: o.randomness,
        }
    }

    pub fn receipt(&self) -> Fr {
        hash(
            &self.cfg,
            DOM_REC,
            &[
                Fr::from(self.amount),
                mint_sender(),
                self.account,
                Fr::from(1u64),
                self.randomness,
            ],
        )
    }

    /// The statement, in allocation order: `(v, rho)`.
    pub fn public_input(&self) -> Vec<Fr> {
        vec![Fr::from(self.amount), self.receipt()]
    }

    pub fn public_input_for(amount: u64, receipt: Fr) -> Vec<Fr> {
        vec![Fr::from(amount), receipt]
    }
}

impl ConstraintSynthesizer<Fr> for DepositCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let amount = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.amount)))?;
        let receipt = FpVar::new_input(cs.clone(), || Ok(self.receipt()))?;
        let account = FpVar::new_witness(cs.clone(), || Ok(self.account))?;
        let randomness = FpVar::new_witness(cs.clone(), || Ok(self.randomness))?;
        let mint = FpVar::Constant(mint_sender());
        let one = FpVar::Constant(Fr::from(1u64));
        hash_var(
            &self.cfg,
            DOM_REC,
            &[amount.clone(), mint, account, one, randomness],
        )?
        .enforce_equal(&receipt)?;
        enforce_range_64(cs, &amount, self.amount)
    }
}

/// A deposit intent as registered with the ledger before the on-chain
/// transfer, and as consumed by the watcher when the transfer is observed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DepositIntent {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "hex_32")]
    pub circuit_id: [u8; 32],
    /// Base units, as a decimal string on JSON boundaries elsewhere; here
    /// the native integer.
    pub amount: u64,
    #[serde(with = "fr_hex")]
    pub receipt: Fr,
    /// 128 bytes, compressed.
    #[serde(with = "hex_vec")]
    pub proof: Vec<u8>,
}

/// The mint the ledger applies once a deposit is finalized: the intent plus
/// the unique deposit identity (chain domain, transaction, log index) that
/// deduplicates it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MintEnvelope {
    pub intent: DepositIntent,
    /// Unique per namespace: `<chain-id>:<tx-hash>:<log-index>` for EVM
    /// deposits. The ledger stores consumed ids and rejects repeats.
    pub deposit_id: String,
}

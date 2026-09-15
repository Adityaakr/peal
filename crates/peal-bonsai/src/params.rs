//! The one instantiation Peal Links runs, and its proving material.
//!
//! Fixed here, not configurable at runtime: a proof is only meaningful under
//! the exact circuit it was made for, and the circuit is fixed by the hash
//! backend and the two tree depths. `CIRCUIT_ID` names that choice; it is
//! carried on every operation record and every persisted wallet so that a
//! future parameter change is a new circuit id rather than a silent
//! reinterpretation of old proofs.
//!
//! Decisions: docs/peal-links/decisions/0001-hash-and-depths.md.

use std::path::Path;

use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use sha2::{Digest, Sha256};
use zkpari::circuits::hasher::{HashCfg, HashKind};
use zkpari::circuits::op::OpCircuit;
use zkpari::{ProvingKey, VerifyingKey, ZkPari};

use crate::{Error, Result, E};

/// Hash backend. Poseidon: ~20x fewer constraints than Pedersen for the
/// receive path, which is what makes browser proving feasible at all.
pub const HASH_KIND: HashKind = HashKind::Poseidon;

/// Receipt-log depth: positions are `[0, 2^RECEIPT_DEPTH)`. Also the width
/// of the nullifier position space (the wallet's sparse Merkle tree has the
/// same depth), so the two bit vectors the circuit binds are one integer.
pub const RECEIPT_DEPTH: usize = 32;
pub const NULL_DEPTH: usize = 32;

/// Circuit family and version. Bump when anything that changes the
/// constraint system changes.
pub const CIRCUIT_VERSION: &str = "peal-links/bonsai-op/v1";

/// Domain separator for account identifiers derived from a spend key.
pub const ACCOUNT_ID_DOMAIN: &[u8] = b"peal-links/v1/account-id";

/// The fixed instantiation: hash configuration plus depths.
#[derive(Clone)]
pub struct Instance {
    pub hash: HashCfg,
    pub receipt_depth: usize,
    pub null_depth: usize,
}

impl Instance {
    /// Building the Poseidon parameters runs the Grain LFSR once; callers
    /// should build one `Instance` and share it.
    pub fn default_instance() -> Self {
        Self {
            hash: HashCfg::of(HASH_KIND),
            receipt_depth: RECEIPT_DEPTH,
            null_depth: NULL_DEPTH,
        }
    }

    pub fn max_positions(&self) -> u64 {
        1u64 << self.receipt_depth
    }

    /// A satisfiable blank circuit of this instance's shape, for keygen.
    pub fn blank_circuit(&self) -> OpCircuit {
        OpCircuit::blank(&self.hash, self.receipt_depth, self.null_depth)
    }
}

impl Default for Instance {
    fn default() -> Self {
        Self::default_instance()
    }
}

/// One circuit's proving and verifying keys with their digests.
pub struct CircuitKeys {
    pub pk: ProvingKey<E>,
    pub vk: VerifyingKey<E>,
    /// sha256 of the compressed verifying key bytes.
    pub vk_digest: [u8; 32],
    /// sha256 of the compressed proving key bytes.
    pub pk_digest: [u8; 32],
}

impl CircuitKeys {
    fn assemble(pk: ProvingKey<E>, vk: VerifyingKey<E>) -> Self {
        let vk_digest = sha256(&vk_to_bytes(&vk));
        let pk_digest = sha256(&pk_to_bytes(&pk));
        Self {
            pk,
            vk,
            vk_digest,
            pk_digest,
        }
    }

    fn generate<C, R>(circuit: C, rng: &mut R) -> Self
    where
        C: zkpari::ConstraintSynthesizer<crate::Fr>,
        R: ark_std::rand::RngCore,
    {
        let (pk, vk) = ZkPari::<E>::keygen(circuit, rng);
        Self::assemble(pk, vk)
    }

    fn save(&self, dir: &Path, name: &str) -> std::io::Result<()> {
        std::fs::write(dir.join(format!("{name}.pk")), pk_to_bytes(&self.pk))?;
        std::fs::write(dir.join(format!("{name}.vk")), vk_to_bytes(&self.vk))
    }

    fn load(dir: &Path, name: &str) -> Result<Self> {
        let io = |e: std::io::Error| Error::Storage(format!("params at {}: {e}", dir.display()));
        let pk = pk_from_bytes(&std::fs::read(dir.join(format!("{name}.pk"))).map_err(io)?)?;
        let vk = vk_from_bytes(&std::fs::read(dir.join(format!("{name}.vk"))).map_err(io)?)?;
        Ok(Self::assemble(pk, vk))
    }
}

/// The proving material for one instance: the operation circuit (R_op) and
/// the deposit circuit (R_dep), plus the circuit id that names both.
pub struct Keys {
    pub op: CircuitKeys,
    pub deposit: CircuitKeys,
    /// Identifies the exact circuits: version tag, backend, depths, and both
    /// verifying keys' matrix digests.
    pub circuit_id: [u8; 32],
}

/// Circuit id from the pieces that determine the constraint systems.
pub fn circuit_id(inst: &Instance, op_vk: &VerifyingKey<E>, dep_vk: &VerifyingKey<E>) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CIRCUIT_VERSION.as_bytes());
    h.update([0u8]);
    h.update(inst.hash.kind().label().as_bytes());
    h.update([0u8]);
    h.update((inst.receipt_depth as u64).to_le_bytes());
    h.update((inst.null_depth as u64).to_le_bytes());
    h.update(op_vk.succinct_index.matrix_digest);
    h.update(dep_vk.succinct_index.matrix_digest);
    h.finalize().into()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn vk_to_bytes(vk: &VerifyingKey<E>) -> Vec<u8> {
    let mut out = Vec::new();
    vk.serialize_with_mode(&mut out, Compress::Yes)
        .expect("in-memory serialization cannot fail");
    out
}

pub fn vk_from_bytes(bytes: &[u8]) -> Result<VerifyingKey<E>> {
    VerifyingKey::<E>::deserialize_with_mode(bytes, Compress::Yes, Validate::Yes)
        .map_err(|e| Error::Wire(format!("verifying key: {e}")))
}

pub fn pk_to_bytes(pk: &ProvingKey<E>) -> Vec<u8> {
    let mut out = Vec::new();
    pk.serialize_with_mode(&mut out, Compress::Yes)
        .expect("in-memory serialization cannot fail");
    out
}

pub fn pk_from_bytes(bytes: &[u8]) -> Result<ProvingKey<E>> {
    // A corrupted proving key would only ever produce proofs that fail to
    // verify; validating on load turns that into an immediate error instead.
    ProvingKey::<E>::deserialize_with_mode(bytes, Compress::Yes, Validate::Yes)
        .map_err(|e| Error::Wire(format!("proving key: {e}")))
}

impl Keys {
    fn assemble(inst: &Instance, op: CircuitKeys, deposit: CircuitKeys) -> Self {
        let circuit_id = circuit_id(inst, &op.vk, &deposit.vk);
        Self {
            op,
            deposit,
            circuit_id,
        }
    }

    /// Run the circuit-specific setups for this instance.
    ///
    /// This is a trusted setup: each trapdoor `(alpha, beta, delta, tau)` is
    /// sampled from `rng` and dropped by `zkpari::ZkPari::keygen`. A key
    /// generated on one machine is therefore only as trustworthy as that
    /// machine's discard of its own randomness, which is why a production
    /// deployment needs a ceremony (docs/peal-links/MAINNET_READINESS.md).
    pub fn generate<R: ark_std::rand::RngCore>(inst: &Instance, rng: &mut R) -> Self {
        let op = CircuitKeys::generate(inst.blank_circuit(), rng);
        let deposit = CircuitKeys::generate(crate::deposit::DepositCircuit::blank(inst), rng);
        Self::assemble(inst, op, deposit)
    }

    /// Write `op.{pk,vk}`, `deposit.{pk,vk}` and `circuit-id` into `dir`.
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        self.op.save(dir, "op")?;
        self.deposit.save(dir, "deposit")?;
        std::fs::write(dir.join("circuit-id"), hex::encode(self.circuit_id))
    }

    /// Load keys saved by [`Keys::save`], recomputing digests and checking
    /// the recorded circuit id.
    pub fn load(inst: &Instance, dir: &Path) -> Result<Self> {
        let io = |e: std::io::Error| Error::Storage(format!("params at {}: {e}", dir.display()));
        let keys = Self::assemble(
            inst,
            CircuitKeys::load(dir, "op")?,
            CircuitKeys::load(dir, "deposit")?,
        );
        let recorded = std::fs::read_to_string(dir.join("circuit-id")).map_err(io)?;
        if recorded.trim() != hex::encode(keys.circuit_id) {
            return Err(Error::Wire("params directory circuit id mismatch".into()));
        }
        Ok(keys)
    }

    /// Load from `dir` if present, otherwise generate and save there.
    pub fn load_or_generate(inst: &Instance, dir: &Path) -> Result<Self> {
        if dir.join("circuit-id").exists() {
            return Self::load(inst, dir);
        }
        let keys = Self::generate(inst, &mut crate::os_rng());
        keys.save(dir)
            .map_err(|e| Error::Storage(format!("saving params: {e}")))?;
        Ok(keys)
    }
}

/// Number of Square R1CS constraints of the instance's circuit, and the
/// evaluation-domain size the prover will use for it.
pub fn constraint_profile(inst: &Instance) -> (usize, usize) {
    let cs = ZkPari::<E>::circuit_to_keygen_cs(inst.blank_circuit()).expect("blank circuit");
    let n = cs.num_constraints();
    (n, n.next_power_of_two())
}

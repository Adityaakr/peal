//! The sigma-protocol proof of knowledge of `k` attached to every v1
//! ciphertext (paper §1 "attach to each ciphertext a simulation-extractable
//! NIZK proof of knowledge of k ... instantiated with a Sigma protocol").
//!
//! Relation: `{ k | ct1 = [k]_1 ∧ ct2 = [k]_2 ∧ ct3 = k·(g' + x·pk) ∧ body }`
//! with `x = H(ct1)`. The body hash is an unconstrained statement variable,
//! so the proof is bound to it (Fig. 1's `ct4`), and `pk` is in the
//! challenge, so the proof is bound to one committee.
//!
//! Fiat-Shamir: `c = H_F(params_digest ‖ context_hash ‖ ct1 ‖ ct2 ‖ ct3 ‖
//! body_hash ‖ A1 ‖ A2 ‖ A3)`, `z = r + c·k`; the verifier recomputes
//! `A_b = z·base_b − c·ct_b`. The parameter digest covers `pk`, every
//! operator key and the DKG output, so a resharing is a different statement.

use super::{compressed, ct3_base, x_of, CtHeader, PublicParams};
use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::field_hashers::{DefaultFieldHasher, HashToField};
use ark_std::rand::{CryptoRng, Rng};
use ark_std::UniformRand;
use sha2::Sha256;

const DST_NIZK: &[u8] = b"PEAL-BTE-V1-NIZK";

/// Two field elements: the challenge and the response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proof {
    pub c: Fr,
    pub z: Fr,
}

/// The public statement a proof is about.
pub struct Statement<'a> {
    pub ct1: &'a G1Affine,
    pub ct2: &'a G2Affine,
    pub ct3: &'a G1Affine,
    pub context_hash: &'a [u8; 32],
    pub body_hash: &'a [u8; 32],
}

fn challenge(
    params: &PublicParams,
    st: &Statement<'_>,
    a1: &G1Affine,
    a2: &G2Affine,
    a3: &G1Affine,
) -> Fr {
    let mut transcript = Vec::with_capacity(64 + 48 * 4 + 96 * 2 + 32);
    transcript.extend_from_slice(&params.digest());
    transcript.extend_from_slice(st.context_hash);
    transcript.extend_from_slice(&compressed(st.ct1));
    transcript.extend_from_slice(&compressed(st.ct2));
    transcript.extend_from_slice(&compressed(st.ct3));
    transcript.extend_from_slice(st.body_hash);
    transcript.extend_from_slice(&compressed(a1));
    transcript.extend_from_slice(&compressed(a2));
    transcript.extend_from_slice(&compressed(a3));
    let hasher = <DefaultFieldHasher<Sha256, 128> as HashToField<Fr>>::new(DST_NIZK);
    hasher.hash_to_field::<1>(&transcript)[0]
}

pub(super) fn prove(
    params: &PublicParams,
    k: Fr,
    st: &Statement<'_>,
    rng: &mut (impl Rng + CryptoRng),
) -> Proof {
    let x = x_of(st.ct1);
    let base3 = ct3_base(params, x);
    let r = Fr::rand(rng);
    let a1 = (G1Projective::generator() * r).into_affine();
    let a2 = (G2Projective::generator() * r).into_affine();
    let a3 = (base3 * r).into_affine();
    let c = challenge(params, st, &a1, &a2, &a3);
    Proof { c, z: r + c * k }
}

/// Verify a header's proof against this committee. Constant work per
/// ciphertext: two G1 and one G2 scalar multiplications plus the hash.
pub fn verify(params: &PublicParams, h: &CtHeader) -> bool {
    let x = x_of(&h.ct1);
    let base3 = ct3_base(params, x);
    let Proof { c, z } = h.proof;
    let a1 = (G1Projective::generator() * z - h.ct1 * c).into_affine();
    let a2 = (G2Projective::generator() * z - h.ct2 * c).into_affine();
    let a3 = (base3 * z - h.ct3 * c).into_affine();
    let st = Statement {
        ct1: &h.ct1,
        ct2: &h.ct2,
        ct3: &h.ct3,
        context_hash: &h.context_hash,
        body_hash: &h.body_hash,
    };
    challenge(params, &st, &a1, &a2, &a3) == c
}

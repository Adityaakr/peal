//! The sigma-protocol proof of knowledge of `k` attached to every v1
//! ciphertext (paper §1 "attach to each ciphertext a simulation-extractable
//! NIZK proof of knowledge of k ... instantiated with a Sigma protocol").
//!
//! Relation: `{ k | ct1 = [k]_1 ∧ ct2 = [k]_2 ∧ ct3 = k·(g' + x·pk) ∧ body }`
//! with `x = H(ct1)`. The body hash is an unconstrained statement variable,
//! so the proof is bound to it (Fig. 1's `ct4`), and `pk` is in the
//! challenge, so the proof is bound to one committee.
//!
//! Fiat-Shamir: `c = H_F(pk ‖ ct1 ‖ ct2 ‖ ct3 ‖ body_hash ‖ A1 ‖ A2 ‖ A3)`,
//! `z = r + c·k`; the verifier recomputes `A_b = z·base_b − c·ct_b`.

use super::{compressed, ct3_base, x_of, CtHeader, PublicParams};
use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::field_hashers::{DefaultFieldHasher, HashToField};
use ark_std::rand::Rng;
use ark_std::UniformRand;
use sha2::Sha256;

const DST_NIZK: &[u8] = b"PEAL-BTE-V1-NIZK";

/// Two field elements: the challenge and the response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proof {
    pub c: Fr,
    pub z: Fr,
}

#[allow(clippy::too_many_arguments)]
fn challenge(
    params: &PublicParams,
    ct1: &G1Affine,
    ct2: &G2Affine,
    ct3: &G1Affine,
    body_hash: &[u8; 32],
    a1: &G1Affine,
    a2: &G2Affine,
    a3: &G1Affine,
) -> Fr {
    let mut transcript = Vec::with_capacity(48 * 5 + 96 * 2 + 32);
    transcript.extend_from_slice(&compressed(&params.pk));
    transcript.extend_from_slice(&compressed(ct1));
    transcript.extend_from_slice(&compressed(ct2));
    transcript.extend_from_slice(&compressed(ct3));
    transcript.extend_from_slice(body_hash);
    transcript.extend_from_slice(&compressed(a1));
    transcript.extend_from_slice(&compressed(a2));
    transcript.extend_from_slice(&compressed(a3));
    let hasher = <DefaultFieldHasher<Sha256, 128> as HashToField<Fr>>::new(DST_NIZK);
    hasher.hash_to_field::<1>(&transcript)[0]
}

pub(super) fn prove(
    params: &PublicParams,
    k: Fr,
    ct1: &G1Affine,
    ct2: &G2Affine,
    ct3: &G1Affine,
    body_hash: &[u8; 32],
    rng: &mut impl Rng,
) -> Proof {
    let x = x_of(ct1);
    let base3 = ct3_base(params, x);
    let r = Fr::rand(rng);
    let a1 = (G1Projective::generator() * r).into_affine();
    let a2 = (G2Projective::generator() * r).into_affine();
    let a3 = (base3 * r).into_affine();
    let c = challenge(params, ct1, ct2, ct3, body_hash, &a1, &a2, &a3);
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
    challenge(params, &h.ct1, &h.ct2, &h.ct3, &h.body_hash, &a1, &a2, &a3) == c
}

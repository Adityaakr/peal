//! An in-process Shamir dealer for the v1 scheme. TEST AND BENCH USE ONLY.
//!
//! The product path is the distributed key generation (`dkg.rs`); this
//! module exists so unit tests and benches can make a committee without a
//! network. It is behind the `dev-dealer` feature, which no binary enables,
//! and its params carry a setup digest that names it.

use super::{OperatorSecret, PublicParams, SETUP_DOMAIN};
use crate::BteError;
use ark_bls12_381::{Fr, G1Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_std::rand::{CryptoRng, Rng};
use ark_std::UniformRand;
use sha2::{Digest, Sha256};

/// Sample `sk`, share it with a random degree-`t-1` polynomial evaluated at
/// `1..=n`, publish `[sk]_1` and every `[sk_j]_1`.
pub fn deal(
    n: u16,
    t: u16,
    rng: &mut (impl Rng + CryptoRng),
) -> Result<(PublicParams, Vec<OperatorSecret>), BteError> {
    if n == 0 || t == 0 || t > n {
        return Err(BteError::InvalidParams("need 1 <= t <= n".into()));
    }
    let mut coefficients: Vec<Fr> = (0..t).map(|_| Fr::rand(rng)).collect();
    while coefficients[0].is_zero() {
        coefficients[0] = Fr::rand(rng);
    }
    let shares: Vec<Fr> = (1..=n as u64)
        .map(|j| {
            let x = Fr::from(j);
            coefficients
                .iter()
                .rev()
                .fold(Fr::from(0u64), |acc, c| acc * x + c)
        })
        .collect();
    let pk = (G1Projective::generator() * coefficients[0]).into_affine();
    let operator_keys = shares
        .iter()
        .map(|s| (G1Projective::generator() * s).into_affine())
        .collect();
    let mut tag = Sha256::new();
    tag.update(SETUP_DOMAIN);
    tag.update(b"dev-dealer");
    let params = PublicParams::assemble(n, t, pk, operator_keys, tag.finalize().into())?;
    let secrets = shares
        .into_iter()
        .enumerate()
        .map(|(i, share)| OperatorSecret::new(i as u16 + 1, share))
        .collect();
    Ok((params, secrets))
}

use ark_ff::Zero;

/// A ciphertext whose proof is valid but whose body is arbitrary bytes, not
/// a DEM output: what a sealer who knows `k` can always produce. Used to
/// test that such a slot opens invalid on its own without touching others.
pub fn seal_with_raw_body(
    params: &PublicParams,
    context: &[u8],
    body: &[u8],
    rng: &mut (impl Rng + CryptoRng),
) -> super::Ciphertext {
    use ark_bls12_381::G2Projective;
    let mut k = Fr::rand(rng);
    while k.is_zero() {
        k = Fr::rand(rng);
    }
    let ct1 = (G1Projective::generator() * k).into_affine();
    let ct2 = (G2Projective::generator() * k).into_affine();
    let x = super::x_of(&ct1);
    let ct3 = (super::ct3_base(params, x) * k).into_affine();
    let body_hash: [u8; 32] = Sha256::digest(body).into();
    let context_hash = super::context_hash(context);
    let statement = super::nizk::Statement {
        ct1: &ct1,
        ct2: &ct2,
        ct3: &ct3,
        context_hash: &context_hash,
        body_hash: &body_hash,
    };
    let proof = super::nizk::prove(params, k, &statement, rng);
    super::Ciphertext {
        ct1,
        ct2,
        ct3,
        context_hash,
        proof,
        body: body.to_vec(),
    }
}

/// Two ciphertexts with randomness `k` and `−k`: what a sealer can do to
/// make a batch's randomness sum to zero. Both verify alone.
pub fn seal_negated_pair(
    params: &PublicParams,
    context: &[u8],
    rng: &mut (impl Rng + CryptoRng),
) -> [super::Ciphertext; 2] {
    let mut k = Fr::rand(rng);
    while k.is_zero() {
        k = Fr::rand(rng);
    }
    [
        seal_with_randomness(params, context, k, rng),
        seal_with_randomness(params, context, -k, rng),
    ]
}

fn seal_with_randomness(
    params: &PublicParams,
    context: &[u8],
    k: Fr,
    rng: &mut (impl Rng + CryptoRng),
) -> super::Ciphertext {
    use ark_bls12_381::G2Projective;
    let context_hash = super::context_hash(context);
    let ct1 = (G1Projective::generator() * k).into_affine();
    let ct2 = (G2Projective::generator() * k).into_affine();
    let x = super::x_of(&ct1);
    let ct3 = (super::ct3_base(params, x) * k).into_affine();
    // Long enough to parse as a body (the wire requires at least a tag).
    let body = b"raw bytes, not a dem output at all".to_vec();
    let body_hash: [u8; 32] = Sha256::digest(&body).into();
    let statement = super::nizk::Statement {
        ct1: &ct1,
        ct2: &ct2,
        ct3: &ct3,
        context_hash: &context_hash,
        body_hash: &body_hash,
    };
    let proof = super::nizk::prove(params, k, &statement, rng);
    super::Ciphertext {
        ct1,
        ct2,
        ct3,
        context_hash,
        proof,
        body,
    }
}

/// Two valid ciphertexts under the same randomness `k` with different
/// bodies: what a sealer who knows `k` can always produce. A relay must
/// refuse the second under one condition (same KEM point).
pub fn seal_twice_with_one_k(
    params: &PublicParams,
    context: &[u8],
    rng: &mut (impl Rng + CryptoRng),
) -> [super::Ciphertext; 2] {
    let mut k = Fr::rand(rng);
    while k.is_zero() {
        k = Fr::rand(rng);
    }
    let mut first = seal_with_randomness(params, context, k, rng);
    let mut second = seal_with_randomness(params, context, k, rng);
    first.body = b"first body, not a dem output....".to_vec();
    second.body = b"second body, not a dem output...".to_vec();
    // Re-prove each over its own body.
    for ct in [&mut first, &mut second] {
        let body_hash: [u8; 32] = Sha256::digest(&ct.body).into();
        let statement = super::nizk::Statement {
            ct1: &ct.ct1,
            ct2: &ct.ct2,
            ct3: &ct.ct3,
            context_hash: &ct.context_hash,
            body_hash: &body_hash,
        };
        ct.proof = super::nizk::prove(params, k, &statement, rng);
    }
    [first, second]
}

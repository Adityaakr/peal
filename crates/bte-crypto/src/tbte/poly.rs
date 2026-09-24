//! Quasi-linear cross terms (paper §4, Lemma 1 and eq. 2).
//!
//! The decryptor needs, for every slot `i`,
//! `U_i = Σ_{j≠i} ct2_j / (x_j − x_i)` and `W_i = Σ_{j≠i} ct3_j / (x_j − x_i)`.
//! Both are the same Cauchy matrix applied to a vector of group elements.
//! With `F(X) = Π_j (X − x_j)` and `N(X) = Σ_j Y_j · F(X)/(X − x_j)`,
//! Lemma 1 gives `N'(x_i) = F'(x_i) · Σ_{j≠i} Y_j/(x_i − x_j) + F''(x_i)/2 · Y_i`,
//! so `Σ_{j≠i} Y_j/(x_j − x_i) = c_i · Y_i − N'(x_i)/F'(x_i)` with
//! `c_i = F''(x_i) / (2 F'(x_i))`.
//!
//! `F` and `N` come from a balanced subproduct tree (`N_{L∪R} = N_L F_R + N_R F_L`),
//! differentiation is linear, and a remainder tree over the same
//! subproduct tree evaluates `N'` at every `x_i`. Products of a group
//! polynomial by a scalar polynomial and the remainders use group FFTs
//! (ark-poly's evaluation domains accept projective points), so the whole
//! thing is O(B log² B) group operations.
//!
//! Measured (examples/tbte_crossover.rs, Apple M5, release, one thread):
//! arkworks' group FFTs multiply points by full-width roots of unity at
//! every butterfly, while the naive path is `B` Pippenger MSMs of size `B`,
//! so the naive path wins by 3.5x to 7x for every batch up to 1024 (the
//! ratio improves about 1.25x per doubling, which extrapolates to a
//! crossover far above any batch Peal freezes). The naive path is therefore
//! the default below `FAST_PATH_MIN_BATCH`; `tests/tbte.rs` proves the two
//! paths agree at every size tried, so the fast path is available to a
//! caller who asks for it (`CrossTermStrategy::Fast`).

use super::CtHeader;
use ark_bls12_381::{Fr, G1Projective, G2Projective};
use ark_ec::AffineRepr;
use ark_ff::{batch_inversion, Field, One, Zero};
use ark_poly::domain::DomainCoeff;
use ark_poly::polynomial::univariate::DensePolynomial;
use ark_poly::{DenseUVPolynomial, EvaluationDomain, Polynomial, Radix2EvaluationDomain};
use std::ops::MulAssign;

/// Below this batch size `CrossTermStrategy::Auto` takes the naive path.
/// Extrapolated from the crossover table in the module docs, not measured
/// at this size; revisit with a windowed group FFT.
pub const FAST_PATH_MIN_BATCH: usize = 32_768;

/// Below this many coefficients the schoolbook product beats a group FFT.
const SCHOOLBOOK_LEN: usize = 16;

type Scalar = DensePolynomial<Fr>;

/// Coefficients of a polynomial with group-element coefficients, low first.
type GroupPoly<G> = Vec<G>;

fn trim<G: Zero>(mut p: GroupPoly<G>) -> GroupPoly<G> {
    while p.last().is_some_and(|c| c.is_zero()) {
        p.pop();
    }
    p
}

/// `N · F` for a group polynomial `N` and a scalar polynomial `F`.
fn mul_group_scalar<G>(n: &[G], f: &Scalar) -> GroupPoly<G>
where
    G: DomainCoeff<Fr> + MulAssign<Fr>,
{
    if n.is_empty() || f.is_zero() {
        return Vec::new();
    }
    let out_len = n.len() + f.coeffs.len() - 1;
    if n.len() < SCHOOLBOOK_LEN || f.coeffs.len() < SCHOOLBOOK_LEN {
        let mut out = vec![G::zero(); out_len];
        for (i, ni) in n.iter().enumerate() {
            for (j, fj) in f.coeffs.iter().enumerate() {
                let mut term = *ni;
                term *= *fj;
                out[i + j] += term;
            }
        }
        return trim(out);
    }
    let domain =
        Radix2EvaluationDomain::<Fr>::new(out_len).expect("degree within the 2-adic domain");
    let mut n_evals = domain.fft(n);
    let f_evals = domain.fft(&f.coeffs);
    for (ne, fe) in n_evals.iter_mut().zip(&f_evals) {
        *ne *= *fe;
    }
    let mut out = domain.ifft(&n_evals);
    out.truncate(out_len);
    trim(out)
}

fn add_group<G: DomainCoeff<Fr>>(a: GroupPoly<G>, b: GroupPoly<G>) -> GroupPoly<G> {
    let (mut long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    for (l, s) in long.iter_mut().zip(short) {
        *l += s;
    }
    trim(long)
}

fn derivative_group<G>(n: &[G]) -> GroupPoly<G>
where
    G: DomainCoeff<Fr> + MulAssign<Fr>,
{
    let mut out: Vec<G> = n
        .iter()
        .enumerate()
        .skip(1)
        .map(|(i, c)| {
            let mut d = *c;
            d *= Fr::from(i as u64);
            d
        })
        .collect();
    out = trim(std::mem::take(&mut out));
    out
}

/// `1 / f mod X^k` by Newton iteration; `f(0)` must be non-zero.
fn inverse_mod_xk(f: &Scalar, k: usize) -> Scalar {
    let f0 = f.coeffs.first().copied().unwrap_or_default();
    assert!(!f0.is_zero(), "series inverse needs a unit constant term");
    let mut g = Scalar::from_coefficients_vec(vec![f0.inverse().expect("non-zero")]);
    let mut precision = 1;
    while precision < k {
        precision *= 2;
        // g ← g · (2 − f·g) mod X^precision
        let f_trunc =
            Scalar::from_coefficients_vec(f.coeffs.iter().take(precision).copied().collect());
        let mut fg = &f_trunc * &g;
        fg.coeffs.truncate(precision);
        let mut two_minus = fg;
        for c in two_minus.coeffs.iter_mut() {
            *c = -*c;
        }
        if two_minus.coeffs.is_empty() {
            two_minus.coeffs.push(Fr::zero());
        }
        two_minus.coeffs[0] += Fr::from(2u64);
        let mut next = &g * &two_minus;
        next.coeffs.truncate(precision);
        g = next;
    }
    g.coeffs.truncate(k);
    g
}

fn reversed<G: Clone>(p: &[G]) -> Vec<G> {
    let mut r = p.to_vec();
    r.reverse();
    r
}

/// `P mod F` for a group polynomial `P` and a monic scalar polynomial `F`.
fn rem_group_scalar<G>(p: &[G], f: &Scalar) -> GroupPoly<G>
where
    G: DomainCoeff<Fr> + MulAssign<Fr>,
{
    let deg_f = f.degree();
    debug_assert!(
        f.coeffs.last().is_some_and(|c| c.is_one()),
        "divisor must be monic"
    );
    let p = trim(p.to_vec());
    if p.len() <= deg_f {
        return p;
    }
    let deg_p = p.len() - 1;
    let deg_q = deg_p - deg_f;
    if deg_f < SCHOOLBOOK_LEN || deg_q < SCHOOLBOOK_LEN {
        // Long division against a monic divisor: no inversions needed.
        let mut r = p;
        for k in (0..=deg_q).rev() {
            let lead = r[k + deg_f];
            if lead.is_zero() {
                continue;
            }
            for (j, fj) in f.coeffs.iter().enumerate().take(deg_f) {
                let mut term = lead;
                term *= *fj;
                r[k + j] -= term;
            }
            r[k + deg_f] = G::zero();
        }
        r.truncate(deg_f);
        return trim(r);
    }
    // Fast division: q = rev(rev(P) · rev(F)^{-1} mod X^{deg_q + 1}).
    let rev_f = Scalar::from_coefficients_vec(reversed(&f.coeffs));
    let inv = inverse_mod_xk(&rev_f, deg_q + 1);
    let mut rev_q = mul_group_scalar(&reversed(&p), &inv);
    rev_q.truncate(deg_q + 1);
    rev_q.resize(deg_q + 1, G::zero());
    let q = reversed(&rev_q);
    let qf = mul_group_scalar(&q, f);
    let mut r = p;
    for (ri, qi) in r.iter_mut().zip(qf) {
        *ri -= qi;
    }
    r.truncate(deg_f);
    trim(r)
}

/// A balanced subproduct tree over the evaluation points.
struct Node {
    /// `F_S(X) = Π_{j ∈ S} (X − x_j)`.
    f: Scalar,
    /// Index of the first point under this node (a leaf holds exactly one).
    start: usize,
    children: Option<(Box<Node>, Box<Node>)>,
}

impl Node {
    fn build(xs: &[Fr], start: usize, end: usize) -> Node {
        if end - start == 1 {
            return Node {
                f: Scalar::from_coefficients_vec(vec![-xs[start], Fr::one()]),
                start,
                children: None,
            };
        }
        let mid = start + (end - start) / 2;
        let left = Node::build(xs, start, mid);
        let right = Node::build(xs, mid, end);
        let f = &left.f * &right.f;
        Node {
            f,
            start,
            children: Some((Box::new(left), Box::new(right))),
        }
    }

    /// `N_S(X) = Σ_{j ∈ S} Y_j · F_S(X) / (X − x_j)`.
    fn numerator<G>(&self, ys: &[G]) -> GroupPoly<G>
    where
        G: DomainCoeff<Fr> + MulAssign<Fr>,
    {
        match &self.children {
            None => trim(vec![ys[self.start]]),
            Some((left, right)) => {
                let nl = left.numerator(ys);
                let nr = right.numerator(ys);
                add_group(
                    mul_group_scalar(&nl, &right.f),
                    mul_group_scalar(&nr, &left.f),
                )
            }
        }
    }

    /// Evaluate the group polynomial `p` at every point under this node,
    /// in index order, by reducing modulo the subproduct polynomials.
    fn evaluate<G>(&self, p: &[G], out: &mut Vec<G>)
    where
        G: DomainCoeff<Fr> + MulAssign<Fr>,
    {
        let r = rem_group_scalar(p, &self.f);
        match &self.children {
            None => out.push(r.first().copied().unwrap_or_else(G::zero)),
            Some((left, right)) => {
                left.evaluate(&r, out);
                right.evaluate(&r, out);
            }
        }
    }
}

fn derivative_scalar(f: &Scalar) -> Scalar {
    Scalar::from_coefficients_vec(
        f.coeffs
            .iter()
            .enumerate()
            .skip(1)
            .map(|(i, c)| *c * Fr::from(i as u64))
            .collect(),
    )
}

/// One Cauchy transform: `Σ_{j≠i} Y_j / (x_j − x_i)` for every `i`.
fn cauchy_transform<G>(tree: &Node, ys: &[G], c: &[Fr], inv_f_prime: &[Fr]) -> Vec<G>
where
    G: DomainCoeff<Fr> + MulAssign<Fr>,
{
    let n = tree.numerator(ys);
    let n_prime = derivative_group(&n);
    let mut n_prime_at = Vec::with_capacity(ys.len());
    tree.evaluate(&n_prime, &mut n_prime_at);
    ys.iter()
        .zip(&n_prime_at)
        .zip(c.iter().zip(inv_f_prime))
        .map(|((y, np), (ci, inv))| {
            let mut a = *y;
            a *= *ci;
            let mut b = *np;
            b *= *inv;
            a - b
        })
        .collect()
}

/// `(U_i, W_i)` for every slot, computed in O(B log² B) group operations.
pub fn cross_terms_fast(batch: &[CtHeader], xs: &[Fr]) -> (Vec<G2Projective>, Vec<G1Projective>) {
    let b = xs.len();
    debug_assert_eq!(batch.len(), b);
    let tree = Node::build(xs, 0, b);
    let f_prime = derivative_scalar(&tree.f);
    let f_second = derivative_scalar(&f_prime);
    let mut inv_f_prime: Vec<Fr> = xs.iter().map(|x| f_prime.evaluate(x)).collect();
    batch_inversion(&mut inv_f_prime);
    let half = Fr::from(2u64).inverse().expect("2 is invertible");
    let c: Vec<Fr> = xs
        .iter()
        .zip(&inv_f_prime)
        .map(|(x, inv)| f_second.evaluate(x) * half * inv)
        .collect();
    let ct2s: Vec<G2Projective> = batch.iter().map(|h| h.ct2.into_group()).collect();
    let ct3s: Vec<G1Projective> = batch.iter().map(|h| h.ct3.into_group()).collect();
    let u = cauchy_transform(&tree, &ct2s, &c, &inv_f_prime);
    let w = cauchy_transform(&tree, &ct3s, &c, &inv_f_prime);
    (u, w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::PrimeGroup;
    use ark_std::rand::SeedableRng;
    use ark_std::UniformRand;
    use rand_chacha::ChaCha20Rng;

    fn scalar_poly_eval_group(p: &[G1Projective], x: Fr) -> G1Projective {
        p.iter().rev().fold(G1Projective::zero(), |acc, c| {
            let mut a = acc;
            a *= x;
            a + *c
        })
    }

    #[test]
    fn group_product_matches_schoolbook_at_every_size() {
        let mut rng = ChaCha20Rng::seed_from_u64(7);
        for (ln, lf) in [(1, 1), (3, 5), (16, 16), (17, 40), (33, 65)] {
            let n: Vec<G1Projective> = (0..ln)
                .map(|_| G1Projective::generator() * Fr::rand(&mut rng))
                .collect();
            let f = Scalar::from_coefficients_vec((0..lf).map(|_| Fr::rand(&mut rng)).collect());
            let prod = mul_group_scalar(&n, &f);
            let x = Fr::rand(&mut rng);
            assert_eq!(
                scalar_poly_eval_group(&prod, x),
                scalar_poly_eval_group(&n, x) * f.evaluate(&x),
                "sizes {ln} x {lf}"
            );
        }
    }

    #[test]
    fn group_remainder_matches_evaluation() {
        let mut rng = ChaCha20Rng::seed_from_u64(8);
        for (lp, roots) in [(5, 2), (40, 20), (70, 33), (128, 64)] {
            let p: Vec<G1Projective> = (0..lp)
                .map(|_| G1Projective::generator() * Fr::rand(&mut rng))
                .collect();
            let xs: Vec<Fr> = (0..roots).map(|_| Fr::rand(&mut rng)).collect();
            let f = xs
                .iter()
                .fold(Scalar::from_coefficients_vec(vec![Fr::one()]), |acc, x| {
                    &acc * &Scalar::from_coefficients_vec(vec![-*x, Fr::one()])
                });
            let r = rem_group_scalar(&p, &f);
            assert!(r.len() <= roots);
            for x in &xs {
                assert_eq!(
                    scalar_poly_eval_group(&r, *x),
                    scalar_poly_eval_group(&p, *x)
                );
            }
        }
    }

    #[test]
    fn series_inverse_is_exact() {
        let mut rng = ChaCha20Rng::seed_from_u64(9);
        let f = Scalar::from_coefficients_vec((0..37).map(|_| Fr::rand(&mut rng)).collect());
        let k = 50;
        let g = inverse_mod_xk(&f, k);
        let mut fg = &f * &g;
        fg.coeffs.truncate(k);
        assert_eq!(fg.coeffs[0], Fr::one());
        assert!(fg.coeffs[1..].iter().all(|c| c.is_zero()));
    }
}

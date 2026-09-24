//! Where the quasi-linear cross terms overtake the naive MSM path.
//!
//! Prints wall-clock time for both at several batch sizes, single process.
//! `NAIVE_THRESHOLD` in `tbte/poly.rs` is set from this table.
//!
//! cargo run --release -p bte-crypto --features full,dev-dealer --example tbte_crossover

use bte_crypto::tbte::{
    cross_terms_naive, dev::deal, poly::cross_terms_fast, seal, x_of, CtHeader,
};
use std::time::Instant;

fn main() {
    let mut rng = bte_crypto::os_rng();
    let (params, _) = deal(5, 3, &mut rng).unwrap();
    let sizes: Vec<usize> = std::env::args()
        .skip(1)
        .map(|s| s.parse().expect("batch size"))
        .collect();
    let sizes = if sizes.is_empty() {
        vec![16, 64, 128, 256, 512, 1024]
    } else {
        sizes
    };
    println!(
        "{:>6} {:>12} {:>12} {:>8}",
        "B", "naive ms", "fast ms", "ratio"
    );
    for b in sizes {
        let headers: Vec<CtHeader> = (0..b)
            .map(|i| {
                seal(&params, format!("slot {i}").as_bytes(), &mut rng)
                    .unwrap()
                    .header()
            })
            .collect();
        let xs: Vec<_> = headers.iter().map(|h| x_of(&h.ct1)).collect();
        let t = Instant::now();
        let (u_naive, w_naive) = cross_terms_naive(&headers, &xs);
        let naive = t.elapsed();
        let t = Instant::now();
        let (u_fast, w_fast) = cross_terms_fast(&headers, &xs);
        let fast = t.elapsed();
        assert_eq!(u_naive, u_fast);
        assert_eq!(w_naive, w_fast);
        println!(
            "{:>6} {:>12.1} {:>12.1} {:>8.2}",
            b,
            naive.as_secs_f64() * 1e3,
            fast.as_secs_f64() * 1e3,
            naive.as_secs_f64() / fast.as_secs_f64()
        );
    }
}

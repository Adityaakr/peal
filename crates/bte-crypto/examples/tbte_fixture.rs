//! Deterministic v1 committee parameters for test fixtures (n=3, t=2, dealt
//! in-process from a fixed seed). Writes the params blob to the given path.
//!
//! cargo run -p bte-crypto --features full,dev-dealer --example tbte_fixture -- packages/sdk/test/fixtures/params-v1.bin

use bte_crypto::rand::SeedableRng;
use bte_crypto::tbte::dev::deal;
use rand_chacha::ChaCha20Rng;

fn main() {
    let path = std::env::args().nth(1).expect("output path");
    let mut rng = ChaCha20Rng::seed_from_u64(20260925);
    let (params, _) = deal(3, 2, &mut rng).expect("valid committee shape");
    std::fs::write(&path, params.to_bytes()).expect("write fixture");
    println!(
        "wrote {} ({} bytes, digest {})",
        path,
        params.to_bytes().len(),
        hex::encode(params.digest())
    );
}

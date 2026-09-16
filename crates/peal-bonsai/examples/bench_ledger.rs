//! Ledger throughput and latency on this machine, with real proofs.
//!
//! Measures, for the actual R_op circuit at the pinned parameters:
//! keygen, native proving (single- and multi-threaded), single verification
//! including strict decoding, batched verification and application for
//! batch sizes 1, 8, 32 and 64 (the same `apply_batch` path the node's
//! ledger actor uses), and the sqlite write cost. Prints a Markdown table
//! for BENCHMARKS.md.
//!
//! Run: `cargo run --release -p peal-bonsai --example bench_ledger`

use std::time::Instant;

use peal_bonsai::account::{namespace_id, OpEnvelope};
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::ledger::{Ledger, LedgerConfig, VerifyingKeys};
use peal_bonsai::params::{Instance, Keys};
use peal_bonsai::wallet::{ReceiptWitness, Wallet};

fn main() {
    let inst = Instance::default_instance();
    let mut rng = peal_bonsai::os_rng();
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    let t = Instant::now();
    let keys = Keys::generate(&inst, &mut rng);
    let keygen_ms = t.elapsed().as_millis();

    let ns = namespace_id("bench");
    let cfg = LedgerConfig {
        namespace: ns,
        circuit_id: keys.circuit_id,
        root_window: 64,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut ledger = Ledger::open(
        &dir.path().join("bench.sqlite"),
        inst.clone(),
        VerifyingKeys::from(&keys),
        cfg,
    )
    .unwrap();

    // N funded wallets, each with one claimable mint receipt.
    let n = 64usize;
    let mut wallets: Vec<Wallet> = (0..n)
        .map(|_| Wallet::create(&inst, keys.circuit_id, ns, &mut rng))
        .collect();
    for w in &mut wallets {
        ledger.register(&w.register_envelope().unwrap()).unwrap();
        w.registered = true;
    }
    let mut mint_positions = Vec::new();
    for (i, w) in wallets.iter_mut().enumerate() {
        let (intent, _) = w
            .prepare_deposit(&inst, &keys, 1_000_000, None, 1, &mut rng)
            .unwrap();
        let applied = ledger
            .mint(&MintEnvelope {
                intent,
                deposit_id: format!("bench:{i}"),
            })
            .unwrap();
        w.deposit_minted(
            &inst,
            ledger.receipt_tree().leaf(applied.position).unwrap(),
            applied.position,
            1,
        );
        mint_positions.push(applied.position);
    }

    // Prove N receive operations (multi-threaded prover, as the node's
    // native tests do) and time a single-threaded one for the record.
    let mut envelopes: Vec<OpEnvelope> = Vec::with_capacity(n);
    let mut prove_ms = Vec::with_capacity(n);
    for (w, pos) in wallets.iter_mut().zip(&mint_positions) {
        let witness = ReceiptWitness {
            path: ledger.receipt_tree().path(*pos).unwrap(),
            root: ledger.receipt_root(),
        };
        w.verify_receipt(&inst, 0, &witness).unwrap();
        let circuit = w.prepare_receive(&inst, 0, &witness, 2, &mut rng).unwrap();
        let t = Instant::now();
        let env = w.prove_pending(&keys, circuit, &mut rng).unwrap();
        prove_ms.push(t.elapsed().as_millis());
        envelopes.push(env);
    }
    prove_ms.sort();
    let prove_median = prove_ms[prove_ms.len() / 2];

    let single_thread_prove_ms = {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        let mut w = Wallet::create(&inst, keys.circuit_id, ns, &mut rng);
        ledger.register(&w.register_envelope().unwrap()).unwrap();
        w.registered = true;
        let (intent, _) = w
            .prepare_deposit(&inst, &keys, 5, None, 1, &mut rng)
            .unwrap();
        let applied = ledger
            .mint(&MintEnvelope {
                intent,
                deposit_id: "bench:st".into(),
            })
            .unwrap();
        w.deposit_minted(
            &inst,
            ledger.receipt_tree().leaf(applied.position).unwrap(),
            applied.position,
            1,
        );
        let witness = ReceiptWitness {
            path: ledger.receipt_tree().path(applied.position).unwrap(),
            root: ledger.receipt_root(),
        };
        w.verify_receipt(&inst, 0, &witness).unwrap();
        let circuit = w.prepare_receive(&inst, 0, &witness, 2, &mut rng).unwrap();
        let t = Instant::now();
        let mut rng2 = peal_bonsai::os_rng();
        let env = pool.install(|| w.prove_pending(&keys, circuit, &mut rng2).unwrap());
        let ms = t.elapsed().as_millis();
        ledger.apply(&env).unwrap();
        ms
    };

    // Single verification including strict decoding (what `apply` does
    // before writing), measured on the verifier alone.
    let verify_us = {
        let env = &envelopes[0];
        let proof = peal_bonsai::encoding::proof_from_bytes(&env.proof).unwrap();
        let input = vec![env.account, env.com, env.com_new, env.receipt, env.root];
        let iters = 50;
        let t = Instant::now();
        for _ in 0..iters {
            let p = peal_bonsai::encoding::proof_from_bytes(&env.proof).unwrap();
            assert!(zkpari::ZkPari::<peal_bonsai::E>::verify(
                &p,
                &keys.op.vk,
                &input
            ));
        }
        let _ = proof;
        t.elapsed().as_micros() / iters
    };

    // Batched application for several batch sizes: the ledger actor's path.
    let mut rows = Vec::new();
    let mut offset = 0;
    for &size in &[1usize, 8, 32, 23] {
        let batch: Vec<OpEnvelope> = envelopes[offset..offset + size].to_vec();
        offset += size;
        let t = Instant::now();
        let results = ledger.apply_batch(&batch, &mut rng);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert!(results.iter().all(|r| r.is_ok()));
        rows.push((size, ms, ms / size as f64));
    }

    // Persisted and replayable.
    let t = Instant::now();
    ledger.verify_replay().unwrap();
    let replay_ms = t.elapsed().as_millis();

    println!("## Ledger benchmark (Apple silicon, {cores} threads, release)\n");
    println!("| measurement | value |");
    println!("|---|---|");
    println!("| keygen R_op + R_dep | {keygen_ms} ms |");
    println!("| R_op prove, {cores} threads, median of {n} | {prove_median} ms |");
    println!("| R_op prove, 1 thread | {single_thread_prove_ms} ms |");
    println!("| single verify incl. strict decode (mean of 50) | {verify_us} us |");
    for (size, ms, per) in rows {
        println!("| apply_batch of {size} (batch verify + sqlite writes) | {ms:.1} ms total, {per:.2} ms per op |");
    }
    println!(
        "| full replay of {} ops (re-verifying every proof) | {replay_ms} ms |",
        ledger.seq()
    );
}

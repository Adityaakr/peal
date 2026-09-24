//! BTE v1 (transparent setup) tests: correctness of Fig. 1, the paper's
//! robustness games (rogue ciphertext, consistency), proof binding, the
//! fast-vs-naive cross-term equivalence, and the wire format.

use bte_crypto::rand::SeedableRng;
use bte_crypto::tbte::wire::{
    pack_headers, unpack_headers, CIPHERTEXT_OVERHEAD_BYTES, HEADER_BYTES, SHARE_BYTES,
};
use bte_crypto::tbte::{
    check_batch, combine, cross_terms_naive, dev::deal, finalize, partial, pre_decrypt,
    pre_decrypt_with, recover, seal, sort_by_ct_hash, verify_ciphertext, verify_share, x_of,
    Ciphertext, CrossTermStrategy, CtHeader, OperatorSecret, PublicParams, Share,
};
use bte_crypto::BteError;
use rand_chacha::ChaCha20Rng;
use std::collections::HashMap;

fn rng() -> ChaCha20Rng {
    ChaCha20Rng::seed_from_u64(4242)
}

#[allow(clippy::type_complexity)]
fn fixture(
    n: u16,
    t: u16,
    b: usize,
) -> (
    PublicParams,
    Vec<OperatorSecret>,
    Vec<Ciphertext>,
    HashMap<[u8; 32], Vec<u8>>,
) {
    let mut rng = rng();
    let (params, secrets) = deal(n, t, &mut rng).unwrap();
    let payloads: Vec<Vec<u8>> = (0..b)
        .map(|i| format!("sealed bid #{i}: {}", 100 + 7 * i).into_bytes())
        .collect();
    let mut batch: Vec<Ciphertext> = payloads
        .iter()
        .map(|p| seal(&params, p, &mut rng).unwrap())
        .collect();
    let by_hash = batch
        .iter()
        .zip(&payloads)
        .map(|(ct, p)| (ct.hash(), p.clone()))
        .collect();
    sort_by_ct_hash(&mut batch);
    (params, secrets, batch, by_hash)
}

fn headers(batch: &[Ciphertext]) -> Vec<CtHeader> {
    batch.iter().map(|ct| ct.header()).collect()
}

#[test]
fn dealer_shares_are_consistent_with_operator_keys() {
    let (params, secrets, _, _) = fixture(5, 3, 1);
    for (i, s) in secrets.iter().enumerate() {
        assert_eq!(s.party_index as usize, i + 1);
        assert_eq!(s.public_key(), params.operator_keys[i]);
    }
}

#[test]
fn roundtrip_three_of_five() {
    let (params, secrets, batch, by_hash) = fixture(5, 3, 6);
    let hdrs = headers(&batch);
    for h in &hdrs {
        assert!(verify_ciphertext(&params, h));
    }
    let shares: Vec<Share> = [0usize, 2, 4]
        .iter()
        .map(|&j| partial(&params, &secrets[j], &hdrs).unwrap())
        .collect();
    for s in &shares {
        assert!(verify_share(&params, &hdrs, s));
    }
    let recovered = recover(&params, &batch, &shares).unwrap();
    assert_eq!(recovered.len(), 6);
    for (slot, ct) in recovered.iter().zip(&batch) {
        assert!(slot.valid);
        assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
    }
}

#[test]
fn any_threshold_subset_recovers_the_same_batch() {
    let (params, secrets, batch, by_hash) = fixture(5, 3, 4);
    let hdrs = headers(&batch);
    let all: Vec<Share> = secrets
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    for subset in [[0, 1, 2], [1, 3, 4], [0, 2, 4], [2, 3, 4]] {
        let shares: Vec<Share> = subset.iter().map(|&j| all[j]).collect();
        let recovered = recover(&params, &batch, &shares).unwrap();
        for (slot, ct) in recovered.iter().zip(&batch) {
            assert!(slot.valid);
            assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
        }
    }
}

#[test]
fn batch_of_one_and_of_many_sizes() {
    for b in [1usize, 2, 3, 7, 17, 33] {
        let (params, secrets, batch, by_hash) = fixture(3, 2, b);
        let hdrs = headers(&batch);
        let shares: Vec<Share> = secrets[..2]
            .iter()
            .map(|s| partial(&params, s, &hdrs).unwrap())
            .collect();
        let recovered = recover(&params, &batch, &shares).unwrap();
        assert_eq!(recovered.len(), b);
        for (slot, ct) in recovered.iter().zip(&batch) {
            assert!(slot.valid, "batch size {b}");
            assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
        }
    }
}

#[test]
fn pipelined_cross_terms_need_no_shares() {
    let (params, secrets, batch, by_hash) = fixture(3, 2, 5);
    let hdrs = headers(&batch);
    let pre = pre_decrypt(&params, &hdrs).unwrap();
    let shares: Vec<Share> = secrets[1..]
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    let combined = combine(&params, &shares).unwrap();
    let recovered = finalize(&params, &pre, &combined, &batch).unwrap();
    for (slot, ct) in recovered.iter().zip(&batch) {
        assert!(slot.valid);
        assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
    }
}

#[test]
fn t_minus_1_shares_fails_explicitly() {
    let (params, secrets, batch, _) = fixture(5, 3, 3);
    let hdrs = headers(&batch);
    let shares: Vec<Share> = secrets[..2]
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    match recover(&params, &batch, &shares) {
        Err(BteError::NotEnoughShares { need: 3, have: 2 }) => {}
        other => panic!("expected NotEnoughShares, got {:?}", other.map(|v| v.len())),
    }
    // A duplicated share does not count twice.
    let dup = vec![shares[0], shares[0], shares[1]];
    assert!(matches!(
        recover(&params, &batch, &dup),
        Err(BteError::NotEnoughShares { .. })
    ));
}

#[test]
fn corrupted_share_is_rejected_and_recovery_survives() {
    let (params, secrets, batch, by_hash) = fixture(5, 3, 3);
    let hdrs = headers(&batch);
    let mut shares: Vec<Share> = secrets[..4]
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    // Operator 2 posts operator 1's value under its own index.
    shares[1].value = shares[0].value;
    assert!(!verify_share(&params, &hdrs, &shares[1]));
    let recovered = recover(&params, &batch, &shares).unwrap();
    for (slot, ct) in recovered.iter().zip(&batch) {
        assert!(slot.valid);
        assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
    }
    // The identity is never a valid share.
    let zero = Share {
        party_index: 5,
        value: <ark_bls12_381::G1Affine as ark_ec::AffineRepr>::zero(),
    };
    assert!(!verify_share(&params, &hdrs, &zero));
}

#[test]
fn share_for_the_wrong_batch_is_rejected() {
    let (params, secrets, batch, _) = fixture(3, 2, 4);
    let hdrs = headers(&batch);
    let share = partial(&params, &secrets[0], &hdrs).unwrap();
    assert!(verify_share(&params, &hdrs, &share));
    assert!(!verify_share(&params, &hdrs[..3], &share));
}

#[test]
fn proof_binds_points_body_and_committee() {
    let mut rng = rng();
    let (params, _) = deal(3, 2, &mut rng).unwrap();
    let (other, _) = deal(3, 2, &mut rng).unwrap();
    let ct = seal(&params, b"bound", &mut rng).unwrap();
    let h = ct.header();
    assert!(verify_ciphertext(&params, &h));
    // Same ciphertext under another committee.
    assert!(!verify_ciphertext(&other, &h));
    // Body swapped.
    let mut mauled = h;
    mauled.body_hash[0] ^= 1;
    assert!(!verify_ciphertext(&params, &mauled));
    // Points swapped for another ciphertext's.
    let ct2 = seal(&params, b"other", &mut rng).unwrap();
    let mut spliced = h;
    spliced.ct3 = ct2.ct3;
    assert!(!verify_ciphertext(&params, &spliced));
    let mut spliced = h;
    spliced.ct2 = ct2.ct2;
    assert!(!verify_ciphertext(&params, &spliced));
    // Proof swapped.
    let mut swapped = h;
    swapped.proof = ct2.proof;
    assert!(!verify_ciphertext(&params, &swapped));
}

#[test]
fn rogue_ciphertext_cannot_enter_a_batch() {
    // A malformed ciphertext (bad proof) is refused before any operator
    // signs, so it cannot make an honest slot fail (Definition 4).
    let (params, secrets, mut batch, _) = fixture(3, 2, 3);
    let mut rogue = batch[0].clone();
    rogue.ct3 = batch[1].ct3;
    batch.push(rogue);
    let hdrs = headers(&batch);
    assert!(matches!(
        check_batch(&params, &hdrs),
        Err(BteError::InvalidCiphertext(_))
    ));
    assert!(matches!(
        partial(&params, &secrets[0], &hdrs),
        Err(BteError::InvalidCiphertext(_))
    ));
    assert!(matches!(
        pre_decrypt(&params, &hdrs),
        Err(BteError::InvalidCiphertext(_))
    ));
}

#[test]
fn duplicate_ciphertext_in_a_batch_is_refused() {
    let (params, _, mut batch, _) = fixture(3, 2, 2);
    batch.push(batch[0].clone());
    let hdrs = headers(&batch);
    match check_batch(&params, &hdrs) {
        Err(BteError::InvalidCiphertext(msg)) => assert!(msg.contains("duplicate")),
        other => panic!(
            "expected duplicate rejection, got {:?}",
            other.map(|v| v.len())
        ),
    }
}

#[test]
fn junk_body_opens_invalid_without_poisoning_the_batch() {
    // A sealer who knows k can attach a valid proof to bytes that are not a
    // DEM output. That slot opens `valid == false`; the others are unaffected.
    let mut rng = rng();
    let (params, secrets) = deal(3, 2, &mut rng).unwrap();
    let honest: Vec<Ciphertext> = (0..3)
        .map(|i| seal(&params, format!("honest {i}").as_bytes(), &mut rng).unwrap())
        .collect();
    let mut batch = honest.clone();
    batch.push(bte_crypto::tbte::dev::seal_with_raw_body(
        &params,
        b"not an aead body at all, definitely",
        &mut rng,
    ));
    sort_by_ct_hash(&mut batch);
    let hdrs = headers(&batch);
    assert!(
        check_batch(&params, &hdrs).is_ok(),
        "the junk ciphertext has a valid proof"
    );
    let shares: Vec<Share> = secrets[..2]
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    let recovered = recover(&params, &batch, &shares).unwrap();
    let honest_hashes: Vec<[u8; 32]> = honest.iter().map(|ct| ct.hash()).collect();
    let mut invalid = 0;
    for (slot, ct) in recovered.iter().zip(&batch) {
        if honest_hashes.contains(&ct.hash()) {
            assert!(slot.valid);
            assert!(slot.payload.starts_with(b"honest "));
        } else {
            assert!(!slot.valid);
            assert!(slot.payload.is_empty());
            invalid += 1;
        }
    }
    assert_eq!(invalid, 1);

    // finalize refuses cross terms computed for a different batch.
    let pre = pre_decrypt(&params, &hdrs).unwrap();
    let combined = combine(&params, &shares).unwrap();
    assert!(finalize(&params, &pre, &combined, &batch[..3]).is_err());
}

#[test]
fn fast_cross_terms_equal_naive() {
    let mut rng = rng();
    let (params, _) = deal(3, 2, &mut rng).unwrap();
    for b in [1usize, 2, 3, 5, 16, 17, 31, 64, 100, 300] {
        let batch: Vec<Ciphertext> = (0..b)
            .map(|i| seal(&params, format!("slot {i}").as_bytes(), &mut rng).unwrap())
            .collect();
        let hdrs = headers(&batch);
        let xs: Vec<_> = hdrs.iter().map(|h| x_of(&h.ct1)).collect();
        let (u_naive, w_naive) = cross_terms_naive(&hdrs, &xs);
        let (u_fast, w_fast) = bte_crypto::tbte::poly::cross_terms_fast(&hdrs, &xs);
        assert_eq!(u_naive, u_fast, "U mismatch at B={b}");
        assert_eq!(w_naive, w_fast, "W mismatch at B={b}");
    }
}

#[test]
fn explicit_fast_strategy_opens_the_batch() {
    let (params, secrets, batch, by_hash) = fixture(3, 2, 20);
    let hdrs = headers(&batch);
    let pre = pre_decrypt_with(&params, &hdrs, CrossTermStrategy::Fast).unwrap();
    let shares: Vec<Share> = secrets[..2]
        .iter()
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    let combined = combine(&params, &shares).unwrap();
    let recovered = finalize(&params, &pre, &combined, &batch).unwrap();
    for (slot, ct) in recovered.iter().zip(&batch) {
        assert!(slot.valid);
        assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
    }
}

#[test]
fn payload_cap_enforced() {
    let mut rng = rng();
    let (params, _) = deal(3, 2, &mut rng).unwrap();
    let big = vec![0u8; bte_crypto::MAX_PAYLOAD_BYTES + 1];
    assert!(matches!(
        seal(&params, &big, &mut rng),
        Err(BteError::PayloadTooLarge)
    ));
    let ok = vec![0u8; 4096];
    assert!(seal(&params, &ok, &mut rng).is_ok());
}

#[test]
fn wire_sizes_and_roundtrips() {
    let (params, secrets, batch, _) = fixture(5, 3, 2);
    let hdrs = headers(&batch);
    let share = partial(&params, &secrets[0], &hdrs).unwrap();

    let share_bytes = share.to_bytes();
    assert_eq!(share_bytes.len(), SHARE_BYTES);
    assert_eq!(Share::from_bytes(&share_bytes).unwrap(), share);

    let header_bytes = hdrs[0].to_bytes();
    assert_eq!(header_bytes.len(), HEADER_BYTES);
    assert_eq!(CtHeader::from_bytes(&header_bytes).unwrap(), hdrs[0]);
    let packed = pack_headers(&hdrs);
    assert_eq!(packed.len(), 2 * HEADER_BYTES);
    assert_eq!(unpack_headers(&packed).unwrap(), hdrs);
    assert!(unpack_headers(&packed[..packed.len() - 1]).is_err());

    let ct_bytes = batch[0].to_bytes();
    let payload_len = batch[0].body.len() - bte_crypto::tbte::DEM_TAG_BYTES;
    assert_eq!(ct_bytes.len(), CIPHERTEXT_OVERHEAD_BYTES + payload_len);
    assert_eq!(Ciphertext::from_bytes(&ct_bytes).unwrap(), batch[0]);
    assert_eq!(&ct_bytes[..4], b"BTE1");

    let params_bytes = params.to_bytes();
    assert_eq!(params_bytes.len(), 5 + 4 + 32 + 48 * 6);
    let back = PublicParams::from_bytes(&params_bytes).unwrap();
    assert_eq!(back.digest(), params.digest());
    assert_eq!(back.to_bytes(), params_bytes);

    let secret_bytes = secrets[0].to_bytes();
    let back = OperatorSecret::from_bytes(&secret_bytes).unwrap();
    assert_eq!(back.party_index, 1);
    assert_eq!(back.public_key(), params.operator_keys[0]);
}

#[test]
fn wire_rejects_malformed() {
    let (params, secrets, batch, _) = fixture(3, 2, 1);
    let hdrs = headers(&batch);
    let share = partial(&params, &secrets[0], &hdrs).unwrap();
    let mut bytes = share.to_bytes();
    bytes[0] = b'X';
    assert!(Share::from_bytes(&bytes).is_err());
    let mut bytes = share.to_bytes();
    bytes.push(0);
    assert!(Share::from_bytes(&bytes).is_err());
    let mut bytes = share.to_bytes();
    bytes[7] ^= 0xff; // inside the point
    assert!(
        Share::from_bytes(&bytes).is_err()
            || !verify_share(&params, &hdrs, &Share::from_bytes(&bytes).unwrap())
    );
    let mut bytes = batch[0].to_bytes();
    bytes[4] = 0x02; // wrong type byte
    assert!(Ciphertext::from_bytes(&bytes).is_err());
    // A v0 blob is not a v1 blob.
    assert!(Ciphertext::from_bytes(b"BTE0\x01").is_err());
    assert!(!bte_crypto::tbte::wire::is_v1(b"BTE0\x01"));
    assert!(bte_crypto::tbte::wire::is_v1(&batch[0].to_bytes()));
}

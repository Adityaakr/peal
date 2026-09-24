//! The committee's key from a real DKG: five operators run Commonware's
//! Feldman/Desmedt protocol over a simulated untrusted relay (envelopes and
//! sealed boxes exactly as the coordinator will carry them), every player
//! finishes with a share, an observer derives the same public parameters,
//! and the resulting committee seals and reveals a batch.

use bte_crypto::rand::SeedableRng;
use bte_crypto::tbte::dkg::{
    box_aad, generate_identity, observe, open_box, seal_box, BoxSecret, Envelope, Identity,
    IdentityKey, Kind, OperatorRound, RoundConfig,
};
use bte_crypto::tbte::{partial, recover, seal, sort_by_ct_hash, Ciphertext, CtHeader, Share};
use rand_chacha::ChaCha20Rng;
use std::collections::HashMap;

fn rng(seed: u64) -> ChaCha20Rng {
    ChaCha20Rng::seed_from_u64(seed)
}

struct Operator {
    identity: Identity,
    key: IdentityKey,
    box_secret: BoxSecret,
    round: OperatorRound,
}

/// The relay as a plain list of envelopes; every operator reads all of them.
#[derive(Default)]
struct Relay {
    envelopes: Vec<Envelope>,
}

fn setup(n: usize, seed: u64) -> (RoundConfig, Vec<Operator>, HashMap<IdentityKey, [u8; 32]>) {
    let mut rng = rng(seed);
    let identities: Vec<Identity> = (0..n).map(|_| generate_identity(&mut rng)).collect();
    let config = RoundConfig {
        committee_tag: b"committee:test".to_vec(),
        round: 0,
        operators: identities
            .iter()
            .map(|i| bte_crypto::tbte::dkg::identity_key_of(i))
            .collect(),
    };
    let mut operators = Vec::new();
    let mut boxes = HashMap::new();
    for identity in identities {
        let box_secret = BoxSecret::generate(&mut rng);
        let key = bte_crypto::tbte::dkg::identity_key_of(&identity);
        boxes.insert(key.clone(), box_secret.public());
        let mut dealer_seed = [0u8; 32];
        bte_crypto::rand::RngCore::fill_bytes(&mut rng, &mut dealer_seed);
        let round = OperatorRound::start(config.clone(), identity.clone(), dealer_seed).unwrap();
        operators.push(Operator {
            identity,
            key,
            box_secret,
            round,
        });
    }
    (config, operators, boxes)
}

/// Dealers publish; players read, verify, acknowledge; dealers close their
/// logs; everyone finalizes. `withhold` names (dealer, player) pairs whose
/// private dealing the relay never delivers.
fn run_round(
    config: &RoundConfig,
    operators: &mut [Operator],
    boxes: &HashMap<IdentityKey, [u8; 32]>,
    withhold: &[(usize, usize)],
) -> Vec<Vec<u8>> {
    let mut rng = rng(99);
    let round = config.digest();
    let mut relay = Relay::default();

    // Dealer phase: one public envelope, one sealed private envelope per player.
    for (d, op) in operators.iter().enumerate() {
        relay.envelopes.push(Envelope::sign(
            &op.identity,
            round,
            Kind::DealerPublic,
            None,
            op.round.public_message(),
        ));
        for (player, plain) in op.round.private_messages() {
            let p = operators.iter().position(|o| o.key == player).unwrap();
            if withhold.contains(&(d, p)) {
                continue;
            }
            let recipient_box = boxes[&player];
            let sealed = seal_box(
                &recipient_box,
                &box_aad(&round, &op.key, &recipient_box),
                &plain,
                &mut rng,
            );
            relay.envelopes.push(Envelope::sign(
                &op.identity,
                round,
                Kind::DealerPrivate,
                Some(player.clone()),
                sealed,
            ));
        }
    }

    // Player phase: every operator reads the relay and acknowledges.
    let mut acks = Vec::new();
    for op in operators.iter_mut() {
        let publics: HashMap<IdentityKey, Vec<u8>> = relay
            .envelopes
            .iter()
            .filter(|e| e.kind == Kind::DealerPublic && e.verify(config))
            .map(|e| (e.from.clone(), e.payload.clone()))
            .collect();
        for e in relay.envelopes.iter().filter(|e| {
            e.kind == Kind::DealerPrivate && e.to.as_ref() == Some(&op.key) && e.verify(config)
        }) {
            let my_box = op.box_secret.public();
            let plain = open_box(
                &op.box_secret,
                &box_aad(&round, &e.from, &my_box),
                &e.payload,
            )
            .unwrap();
            let ack = op
                .round
                .receive_dealing(&e.from, &publics[&e.from], &plain)
                .unwrap()
                .expect("first delivery");
            acks.push(Envelope::sign(
                &op.identity,
                round,
                Kind::Ack,
                Some(e.from.clone()),
                ack,
            ));
        }
    }
    relay.envelopes.extend(acks);

    // Dealers collect acks and close.
    let mut logs = Vec::new();
    for op in operators.iter_mut() {
        for e in relay
            .envelopes
            .iter()
            .filter(|e| e.kind == Kind::Ack && e.to.as_ref() == Some(&op.key) && e.verify(config))
        {
            op.round.receive_ack(&e.from, &e.payload).unwrap();
        }
        let log = op.round.finalize_dealer().unwrap();
        logs.push(log.clone());
        relay
            .envelopes
            .push(Envelope::sign(&op.identity, round, Kind::Log, None, log));
    }
    logs
}

#[test]
fn five_operators_agree_on_a_committee_and_it_reveals() {
    let (config, mut operators, boxes) = setup(5, 1);
    assert_eq!(config.n(), 5);
    // N3f1 with five operators: f = 1, quorum 4, so four shares reconstruct.
    assert_eq!(config.threshold(), 4);
    assert_eq!(config.quorum(), 4);
    let logs = run_round(&config, &mut operators, &boxes, &[]);

    // An observer (the coordinator) derives the parameters from the logs.
    let observed = observe(&config, &logs, [7u8; 32]).unwrap();
    assert!(observed.secret.is_none());
    let params = observed.params.clone();
    assert_eq!(params.n(), 5);
    assert_eq!(params.t(), 4);
    let again = bte_crypto::tbte::dkg::params_from_encoded_output(&observed.output).unwrap();
    assert_eq!(again.digest(), params.digest());

    // Every player finishes with a share matching the public polynomial.
    let mut secrets = Vec::new();
    for op in operators {
        let party = config.party_index(&op.key).unwrap();
        let result = op.round.finalize(&logs, [9u8; 32]).unwrap();
        assert_eq!(
            result.params.digest(),
            params.digest(),
            "players and observer agree"
        );
        let secret = result.secret.unwrap();
        assert_eq!(secret.party_index, party);
        assert_eq!(
            secret.public_key(),
            params.operator_keys()[party as usize - 1]
        );
        secrets.push(secret);
    }

    // The committee works: seal, four shares, reveal.
    let mut rng = rng(5);
    let payloads: Vec<Vec<u8>> = (0..4)
        .map(|i| format!("dkg-sealed {i}").into_bytes())
        .collect();
    let mut batch: Vec<Ciphertext> = payloads
        .iter()
        .map(|p| seal(&params, b"condition:dkg", p, &mut rng).unwrap())
        .collect();
    let by_hash: HashMap<[u8; 32], Vec<u8>> = batch
        .iter()
        .zip(&payloads)
        .map(|(c, p)| (c.hash(), p.clone()))
        .collect();
    sort_by_ct_hash(&mut batch);
    let hdrs: Vec<CtHeader> = batch.iter().map(|c| c.header()).collect();
    let shares: Vec<Share> = secrets
        .iter()
        .take(4)
        .map(|s| partial(&params, s, &hdrs).unwrap())
        .collect();
    let recovered = recover(&params, &batch, &shares).unwrap();
    for (slot, ct) in recovered.iter().zip(&batch) {
        assert!(slot.valid);
        assert_eq!(&slot.payload, &by_hash[&ct.hash()]);
    }
    // Three shares are not enough.
    assert!(recover(&params, &batch, &shares[..3]).is_err());
}

#[test]
fn a_withheld_dealing_is_revealed_and_the_round_still_succeeds() {
    let (config, mut operators, boxes) = setup(5, 2);
    // Dealer 0 never delivers to player 3: the log carries a reveal for it.
    let logs = run_round(&config, &mut operators, &boxes, &[(0, 3)]);
    let observed = observe(&config, &logs, [1u8; 32]).unwrap();
    let params = observed.params;
    for op in operators {
        let party = config.party_index(&op.key).unwrap();
        let result = op.round.finalize(&logs, [2u8; 32]).unwrap();
        assert_eq!(result.params.digest(), params.digest());
        assert_eq!(
            result.secret.unwrap().public_key(),
            params.operator_keys()[party as usize - 1]
        );
    }
}

#[test]
fn tampered_dealings_envelopes_and_boxes_are_rejected() {
    let (config, mut operators, boxes) = setup(4, 3);
    let round = config.digest();
    let mut rng = rng(11);

    // A private dealing altered in transit fails the box (AEAD) check.
    let (player, plain) = operators[0]
        .round
        .private_messages()
        .into_iter()
        .nth(1)
        .unwrap();
    let recipient_box = boxes[&player];
    let dealer_key = operators[0].key.clone();
    let mut sealed = seal_box(
        &recipient_box,
        &box_aad(&round, &dealer_key, &recipient_box),
        &plain,
        &mut rng,
    );
    let p = operators.iter().position(|o| o.key == player).unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 1;
    assert!(open_box(
        &operators[p].box_secret,
        &box_aad(&round, &dealer_key, &recipient_box),
        &sealed
    )
    .is_err());

    // The same box under another dealer's name fails (AAD binds the dealer).
    let sealed = seal_box(
        &recipient_box,
        &box_aad(&round, &dealer_key, &recipient_box),
        &plain,
        &mut rng,
    );
    let other_dealer = operators[2].key.clone();
    assert!(open_box(
        &operators[p].box_secret,
        &box_aad(&round, &other_dealer, &recipient_box),
        &sealed
    )
    .is_err());
    assert!(open_box(
        &operators[p].box_secret,
        &box_aad(&round, &dealer_key, &recipient_box),
        &sealed
    )
    .is_ok());

    // A dealing whose scalar was replaced is rejected by the player against
    // the dealer's public commitment.
    let public = operators[0].round.public_message();
    let mut forged = plain.clone();
    forged[0] ^= 1;
    assert!(operators[p]
        .round
        .receive_dealing(&dealer_key, &public, &forged)
        .is_err());

    // Envelopes: a signature by someone outside the round, a wrong round,
    // and a payload edit all fail verification.
    let outsider = generate_identity(&mut rng);
    let e = Envelope::sign(&outsider, round, Kind::DealerPublic, None, public.clone());
    assert!(!e.verify(&config));
    let e = Envelope::sign(
        &operators[1].identity,
        [0u8; 32],
        Kind::DealerPublic,
        None,
        public.clone(),
    );
    assert!(!e.verify(&config));
    let mut e = Envelope::sign(
        &operators[1].identity,
        round,
        Kind::DealerPublic,
        None,
        public.clone(),
    );
    assert!(e.verify(&config));
    e.payload[0] ^= 1;
    assert!(!e.verify(&config));
    // Impersonation: relabeling the sender breaks the signature.
    let mut e = Envelope::sign(
        &operators[1].identity,
        round,
        Kind::DealerPublic,
        None,
        public,
    );
    e.from = operators[2].key.clone();
    assert!(!e.verify(&config));

    // Envelope wire roundtrip.
    let e = Envelope::sign(
        &operators[1].identity,
        round,
        Kind::Ack,
        Some(operators[0].key.clone()),
        b"ack".to_vec(),
    );
    let back = Envelope::from_bytes(&e.to_bytes()).unwrap();
    assert_eq!(back, e);
    assert!(back.verify(&config));
    assert!(Envelope::from_bytes(&e.to_bytes()[..10]).is_err());
}

#[test]
fn a_round_short_of_quorum_fails_explicitly() {
    let (config, mut operators, boxes) = setup(5, 4);
    let logs = run_round(&config, &mut operators, &boxes, &[]);
    // Only three of the five dealer logs reach the observer; quorum is four.
    assert!(observe(&config, &logs[..3], [3u8; 32]).is_err());
    assert!(observe(&config, &logs[..4], [3u8; 32]).is_ok());
}

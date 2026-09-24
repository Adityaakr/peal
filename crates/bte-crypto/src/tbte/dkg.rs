//! The committee's key from a distributed key generation.
//!
//! "DKG is all you need": the v1 scheme's whole secret is one scalar `sk`
//! Shamir-shared among the operators. This module drives Commonware's
//! Feldman/Desmedt DKG (`commonware_cryptography::bls12381::dkg::feldman_desmedt`,
//! Joint-Feldman from GJKR99 with signed dealer logs and share reveals) with
//! ed25519 operator identities, then converts its output to the arkworks
//! types the scheme uses: `pk = [sk]_1`, `pk_j = [sk_j]_1`, and each
//! operator's share `sk_j` as an `Fr`.
//!
//! Every operator is both a dealer and a player. The fault model is
//! Commonware's `N3f1` (`f = ⌊(n − 1) / 3⌋`, quorum `n − f`), the one its
//! reveal analysis covers: the shared polynomial has degree `quorum − 1`,
//! so the scheme's threshold is `t = n − f` (three of four, four of five,
//! five of seven) and `n − f` dealer logs close a round. A weaker model
//! would give three of five but loses secrecy under asynchrony, so it is
//! not offered. Party index `j` (1-based, the scheme's Lagrange abscissa)
//! is the operator's position in the sorted set of identity keys plus one,
//! which is where the DKG evaluates its polynomial (`Mode::NonZeroCounter`).
//!
//! Transport is whoever relays bytes between operators (the coordinator, as
//! an untrusted bulletin board). Public dealer messages and signed logs go
//! in the clear inside an `Envelope` signed by the sender's identity;
//! private dealings additionally travel inside a `SealedBox` to the
//! recipient's X25519 key. The relay can stall the round; it cannot learn
//! a share, forge a dealer, or make an operator accept a dealing it did
//! not send.

use super::{OperatorSecret, PublicParams, SETUP_DOMAIN};
use crate::BteError;
use ark_bls12_381::{Fr, G1Affine, G1Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::{BigInteger, PrimeField};
use ark_serialize::CanonicalDeserialize;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use commonware_codec::{Decode, DecodeExt, Encode};
use commonware_cryptography::bls12381::dkg::feldman_desmedt::Reveal;
use commonware_cryptography::bls12381::dkg::feldman_desmedt::{
    observe as fd_observe, Dealer, DealerLog, DealerPrivMsg, DealerPubMsg, Info, Logs, Output,
    Player, PlayerAck, SignedDealerLog,
};
use commonware_cryptography::bls12381::primitives::sharing::{Mode, ModeVersion};
use commonware_cryptography::bls12381::primitives::variant::MinPk;
use commonware_cryptography::{Signer, Verifier};
use commonware_parallel::Sequential;
use commonware_utils::ordered::Set;
use commonware_utils::{N3f1, Participant, NZU32};
use core::num::NonZeroU32;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

pub use commonware_cryptography::ed25519::{
    Batch as IdentityBatch, PrivateKey as Identity, PublicKey as IdentityKey,
    Signature as IdentitySignature,
};

/// The DKG's fault model: `n >= 3f + 1`, quorum `n - f`, degree `n - f - 1`.
pub type Faults = N3f1;

/// Namespace every round commits to; fixed for the protocol's lifetime.
pub const NAMESPACE: &[u8] = b"PEAL-BTE-V1-DKG";
/// Signature namespace for relay envelopes.
const ENVELOPE_NAMESPACE: &[u8] = b"PEAL-BTE-V1-DKG-ENVELOPE";
/// HKDF salt for sealed private dealings.
const BOX_SALT: &[u8] = b"PEAL-BTE-V1-DKG-BOX";
/// Upper bound on participants accepted when decoding messages.
const MAX_PARTICIPANTS: NonZeroU32 = NZU32!(1024);

fn err(what: impl std::fmt::Display) -> BteError {
    BteError::InvalidParams(format!("dkg: {what}"))
}

/// Everything a round is defined by. All operators must agree on it
/// byte for byte; `digest()` is what they compare.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundConfig {
    /// Names the committee inside the namespace (for example a committee id).
    pub committee_tag: Vec<u8>,
    /// Increments for every attempt, failed ones included.
    pub round: u64,
    /// The operators' identity keys; order does not matter.
    pub operators: Vec<IdentityKey>,
}

impl RoundConfig {
    fn operator_set(&self) -> Result<Set<IdentityKey>, BteError> {
        let n = self.operators.len();
        if !(1..=MAX_PARTICIPANTS.get() as usize).contains(&n) {
            return Err(err(format!("{n} operators")));
        }
        let set = Set::try_from(self.operators.clone())
            .map_err(|_| err("duplicate operator identity"))?;
        Ok(set)
    }

    fn info(&self) -> Result<Info<MinPk, IdentityKey>, BteError> {
        let set = self.operator_set()?;
        let mut namespace = NAMESPACE.to_vec();
        namespace.push(0);
        namespace.extend_from_slice(&self.committee_tag);
        Info::new::<Faults>(
            &namespace,
            self.round,
            None,
            Mode::NonZeroCounter,
            Reveal::V1,
            set.clone(),
            set,
        )
        .map_err(|e| err(format!("{e:?}")))
    }

    /// Binds envelopes to one round.
    pub fn digest(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(NAMESPACE);
        h.update((self.committee_tag.len() as u32).to_le_bytes());
        h.update(&self.committee_tag);
        h.update(self.round.to_le_bytes());
        if let Ok(set) = self.operator_set() {
            for pk in set.iter() {
                h.update(pk.encode());
            }
        }
        h.finalize().into()
    }

    /// Number of operators.
    pub fn n(&self) -> u16 {
        self.operators.len() as u16
    }

    /// Shares needed to reconstruct: the polynomial degree plus one, which
    /// the DKG sets to the quorum `n − f`.
    pub fn threshold(&self) -> u16 {
        self.quorum()
    }

    /// Dealer logs needed for the round to succeed.
    pub fn quorum(&self) -> u16 {
        <Faults as commonware_utils::Faults>::quorum(self.operators.len()) as u16
    }

    /// The scheme's 1-based party index of an operator.
    pub fn party_index(&self, operator: &IdentityKey) -> Result<u16, BteError> {
        let set = self.operator_set()?;
        set.position(operator)
            .map(|p| p as u16 + 1)
            .ok_or_else(|| err("operator not in round"))
    }
}

/// A Commonware-side RNG seeded from ours (their rand generation differs).
fn cw_rng(seed: [u8; 32]) -> rand_chacha_cw::ChaCha20Rng {
    <rand_chacha_cw::ChaCha20Rng as rand_core_cw::SeedableRng>::from_seed(seed)
}

/// One operator's state through a round: its dealer and its player.
pub struct OperatorRound {
    config: RoundConfig,
    info: Info<MinPk, IdentityKey>,
    me: Identity,
    dealer: Option<Dealer<MinPk, Identity>>,
    pub_msg: DealerPubMsg<MinPk>,
    priv_msgs: Vec<(IdentityKey, DealerPrivMsg)>,
    player: Player<MinPk, Identity>,
}

impl OperatorRound {
    /// Start the round. `dealer_seed` must be fresh entropy the first time;
    /// keeping it lets a restarted process regenerate the same dealing.
    pub fn start(
        config: RoundConfig,
        me: Identity,
        dealer_seed: [u8; 32],
    ) -> Result<Self, BteError> {
        let info = config.info()?;
        let (dealer, pub_msg, priv_msgs) =
            Dealer::start::<Faults>(cw_rng(dealer_seed), info.clone(), me.clone(), None)
                .map_err(|e| err(format!("{e:?}")))?;
        let player = Player::new(info.clone(), me.clone()).map_err(|e| err(format!("{e:?}")))?;
        Ok(OperatorRound {
            config,
            info,
            me,
            dealer: Some(dealer),
            pub_msg,
            priv_msgs,
            player,
        })
    }

    pub fn config(&self) -> &RoundConfig {
        &self.config
    }

    pub fn identity(&self) -> IdentityKey {
        self.me.public_key()
    }

    /// The dealer's public commitment, to broadcast (signed, in the clear).
    pub fn public_message(&self) -> Vec<u8> {
        self.pub_msg.encode().to_vec()
    }

    /// The dealer's private dealing for every player, to be sealed to each.
    pub fn private_messages(&self) -> Vec<(IdentityKey, Vec<u8>)> {
        self.priv_msgs
            .iter()
            .map(|(pk, msg)| (pk.clone(), msg.encode().to_vec()))
            .collect()
    }

    /// Process another dealer's (public, private) pair. Returns the
    /// acknowledgement to send back, or `None` if already processed.
    pub fn receive_dealing(
        &mut self,
        dealer: &IdentityKey,
        pub_msg: &[u8],
        priv_msg: &[u8],
    ) -> Result<Option<Vec<u8>>, BteError> {
        let pub_msg = DealerPubMsg::<MinPk>::decode_cfg(pub_msg, &MAX_PARTICIPANTS)
            .map_err(|e| err(format!("public message: {e}")))?;
        let priv_msg =
            DealerPrivMsg::decode(priv_msg).map_err(|e| err(format!("private message: {e}")))?;
        let ack = self
            .player
            .dealer_message::<Faults>(dealer.clone(), pub_msg, priv_msg)
            .map_err(|e| err(format!("dealing rejected: {e:?}")))?;
        Ok(ack.map(|a| a.encode().to_vec()))
    }

    /// Record a player's acknowledgement of our dealing.
    pub fn receive_ack(&mut self, player: &IdentityKey, ack: &[u8]) -> Result<(), BteError> {
        let ack = PlayerAck::<IdentityKey>::decode(ack).map_err(|e| err(format!("ack: {e}")))?;
        let dealer = self
            .dealer
            .as_mut()
            .ok_or_else(|| err("dealer already finalized"))?;
        dealer
            .receive_player_ack(player.clone(), ack)
            .map_err(|e| err(format!("ack rejected: {e:?}")))
    }

    /// Close our dealing: the signed log (acks, or reveals for players who
    /// did not acknowledge in time), to broadcast.
    pub fn finalize_dealer(&mut self) -> Result<Vec<u8>, BteError> {
        let dealer = self
            .dealer
            .take()
            .ok_or_else(|| err("dealer already finalized"))?;
        Ok(dealer.finalize::<Faults>().encode().to_vec())
    }

    /// Finish the round from the agreed set of signed dealer logs: the
    /// committee's public parameters and this operator's share.
    pub fn finalize(
        self,
        signed_logs: &[Vec<u8>],
        seed: [u8; 32],
    ) -> Result<RoundResult, BteError> {
        let logs = collect_logs(&self.info, signed_logs)?;
        let (output, share) = self
            .player
            .finalize::<Faults, IdentityBatch>(&mut cw_rng(seed), logs, &Sequential)
            .map_err(|e| err(format!("finalize: {e:?}")))?;
        let params = params_from_output(&output)?;
        let party_index = self.config.party_index(&self.me.public_key())?;
        let secret = share_to_secret(&share, party_index)?;
        if secret.public_key() != params.operator_keys()[party_index as usize - 1] {
            return Err(err("share does not match the public polynomial"));
        }
        Ok(RoundResult {
            params,
            secret: Some(secret),
            output: output.encode().to_vec(),
        })
    }
}

/// What a finished round yields.
pub struct RoundResult {
    pub params: PublicParams,
    /// Present for a player, absent for an observer.
    pub secret: Option<OperatorSecret>,
    /// The DKG output, encoded, for anyone to re-derive the parameters.
    pub output: Vec<u8>,
}

fn collect_logs(
    info: &Info<MinPk, IdentityKey>,
    signed_logs: &[Vec<u8>],
) -> Result<Logs<MinPk, IdentityKey, Faults>, BteError> {
    let mut logs = Logs::new(info.clone());
    for bytes in signed_logs {
        let signed =
            SignedDealerLog::<MinPk, Identity>::decode_cfg(bytes.as_slice(), &MAX_PARTICIPANTS)
                .map_err(|e| err(format!("signed log: {e}")))?;
        let (dealer, log): (IdentityKey, DealerLog<MinPk, IdentityKey>) = signed
            .check(info)
            .ok_or_else(|| err("signed log: bad signature"))?;
        logs.record(dealer, log);
    }
    Ok(logs)
}

/// Anyone with the signed logs derives the same public parameters the
/// players did (the coordinator uses this to publish the committee).
pub fn observe(
    config: &RoundConfig,
    signed_logs: &[Vec<u8>],
    seed: [u8; 32],
) -> Result<RoundResult, BteError> {
    let info = config.info()?;
    let logs = collect_logs(&info, signed_logs)?;
    let output = fd_observe::<MinPk, IdentityKey, Faults, IdentityBatch>(
        &mut cw_rng(seed),
        logs,
        &Sequential,
    )
    .map_err(|e| err(format!("observe: {e:?}")))?;
    Ok(RoundResult {
        params: params_from_output(&output)?,
        secret: None,
        output: output.encode().to_vec(),
    })
}

/// Re-derive public parameters from an encoded DKG output.
pub fn params_from_encoded_output(bytes: &[u8]) -> Result<PublicParams, BteError> {
    let output =
        Output::<MinPk, IdentityKey>::decode_cfg(bytes, &(MAX_PARTICIPANTS, ModeVersion::v1()))
            .map_err(|e| err(format!("output: {e}")))?;
    params_from_output(&output)
}

fn g1_to_ark(
    point: &commonware_cryptography::bls12381::primitives::group::G1,
) -> Result<G1Affine, BteError> {
    // Both libraries use the zcash compressed encoding of BLS12-381 G1.
    G1Affine::deserialize_compressed(point.encode().as_ref()).map_err(|_| err("G1 conversion"))
}

fn params_from_output(output: &Output<MinPk, IdentityKey>) -> Result<PublicParams, BteError> {
    let sharing = output.public();
    let n = output.players().len();
    let t = sharing.required();
    let pk = g1_to_ark(sharing.public())?;
    let mut operator_keys = Vec::with_capacity(n);
    for i in 0..n {
        let key = sharing
            .partial_public(Participant::from_usize(i))
            .map_err(|e| err(format!("{e:?}")))?;
        operator_keys.push(g1_to_ark(&key)?);
    }
    let mut digest = Sha256::new();
    digest.update(SETUP_DOMAIN);
    digest.update(output.encode());
    PublicParams::assemble(
        n as u16,
        t as u16,
        pk,
        operator_keys,
        digest.finalize().into(),
    )
}

fn share_to_secret(
    share: &commonware_cryptography::bls12381::primitives::group::Share,
    party_index: u16,
) -> Result<OperatorSecret, BteError> {
    if share.index.get() as u16 + 1 != party_index {
        return Err(err("share index does not match party index"));
    }
    // Commonware scalars encode big-endian and are always reduced.
    let bytes = share.private.expose(|s| s.encode());
    let fr = Fr::from_be_bytes_mod_order(bytes.as_ref());
    let expected = share.private.expose(|s| s.encode());
    if fr.into_bigint().to_bytes_be() != expected.as_ref() {
        return Err(err("scalar conversion"));
    }
    Ok(OperatorSecret::new(party_index, fr))
}

/// `[sk_j]_1` of a converted share, for checks against the public polynomial.
pub fn share_public_key(secret: &OperatorSecret) -> G1Affine {
    (G1Projective::generator() * secret.share).into_affine()
}

// ---------------------------------------------------------------------
// Relay transport: signed envelopes and sealed private dealings.
// ---------------------------------------------------------------------

/// What a relayed message is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// A dealer's public commitment.
    DealerPublic = 1,
    /// A dealer's private dealing to one player, sealed.
    DealerPrivate = 2,
    /// A player's acknowledgement of one dealer.
    Ack = 3,
    /// A dealer's signed log.
    Log = 4,
}

impl Kind {
    fn from_u8(b: u8) -> Option<Kind> {
        match b {
            1 => Some(Kind::DealerPublic),
            2 => Some(Kind::DealerPrivate),
            3 => Some(Kind::Ack),
            4 => Some(Kind::Log),
            _ => None,
        }
    }
}

/// A relayed message: who sent it, for which round, to whom (if private),
/// and the sender's signature over all of that plus the payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub from: IdentityKey,
    pub round: [u8; 32],
    pub kind: Kind,
    /// The counterpart: the dealer an ack answers, or the player a private
    /// dealing is for. Empty for broadcasts.
    pub to: Option<IdentityKey>,
    pub payload: Vec<u8>,
    pub signature: IdentitySignature,
}

fn envelope_message(
    round: &[u8; 32],
    kind: Kind,
    to: &Option<IdentityKey>,
    payload: &[u8],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(32 + 1 + 33 + payload.len());
    m.extend_from_slice(round);
    m.push(kind as u8);
    match to {
        Some(pk) => {
            m.push(1);
            m.extend_from_slice(&pk.encode());
        }
        None => m.push(0),
    }
    m.extend_from_slice(payload);
    m
}

impl Envelope {
    pub fn sign(
        me: &Identity,
        round: [u8; 32],
        kind: Kind,
        to: Option<IdentityKey>,
        payload: Vec<u8>,
    ) -> Envelope {
        let signature = me.sign(
            ENVELOPE_NAMESPACE,
            &envelope_message(&round, kind, &to, &payload),
        );
        Envelope {
            from: me.public_key(),
            round,
            kind,
            to,
            payload,
            signature,
        }
    }

    /// Signature valid, round matches, sender is an operator of the round.
    pub fn verify(&self, config: &RoundConfig) -> bool {
        self.round == config.digest()
            && config.operators.contains(&self.from)
            && self
                .to
                .as_ref()
                .is_none_or(|to| config.operators.contains(to))
            && self.from.verify(
                ENVELOPE_NAMESPACE,
                &envelope_message(&self.round, self.kind, &self.to, &self.payload),
                &self.signature,
            )
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.from.encode());
        out.extend_from_slice(&self.round);
        out.push(self.kind as u8);
        match &self.to {
            Some(pk) => {
                out.push(1);
                out.extend_from_slice(&pk.encode());
            }
            None => out.push(0),
        }
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.payload);
        out.extend_from_slice(&self.signature.encode());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Envelope, BteError> {
        let mut pos = 0;
        let mut take = |n: usize| -> Result<&[u8], BteError> {
            if bytes.len() - pos < n {
                return Err(BteError::Wire("envelope truncated".into()));
            }
            let s = &bytes[pos..pos + n];
            pos += n;
            Ok(s)
        };
        let from =
            IdentityKey::decode(take(32)?).map_err(|_| BteError::Wire("envelope sender".into()))?;
        let round: [u8; 32] = take(32)?.try_into().unwrap();
        let kind =
            Kind::from_u8(take(1)?[0]).ok_or_else(|| BteError::Wire("envelope kind".into()))?;
        let to = match take(1)?[0] {
            0 => None,
            1 => Some(
                IdentityKey::decode(take(32)?)
                    .map_err(|_| BteError::Wire("envelope recipient".into()))?,
            ),
            _ => return Err(BteError::Wire("envelope recipient flag".into())),
        };
        let len = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
        if len > 1 << 24 {
            return Err(BteError::Wire("envelope payload too large".into()));
        }
        let payload = take(len)?.to_vec();
        let signature = IdentitySignature::decode(take(64)?)
            .map_err(|_| BteError::Wire("envelope signature".into()))?;
        if pos != bytes.len() {
            return Err(BteError::Wire("envelope trailing bytes".into()));
        }
        Ok(Envelope {
            from,
            round,
            kind,
            to,
            payload,
            signature,
        })
    }
}

/// An operator's long-term X25519 key for receiving private dealings.
pub struct BoxSecret(x25519_dalek::StaticSecret);

impl BoxSecret {
    pub fn generate(rng: &mut impl ark_std::rand::Rng) -> BoxSecret {
        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        BoxSecret(x25519_dalek::StaticSecret::from(seed))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> BoxSecret {
        BoxSecret(x25519_dalek::StaticSecret::from(bytes))
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn public(&self) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&self.0).to_bytes()
    }
}

/// Ephemeral-static Diffie-Hellman, HKDF-SHA256, ChaCha20-Poly1305. The AAD
/// binds the box to the round, the sender's identity and the recipient's
/// key; authenticity of the sender comes from the envelope signature.
pub fn seal_box(
    recipient: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
    rng: &mut impl ark_std::rand::Rng,
) -> Vec<u8> {
    let mut seed = [0u8; 32];
    rng.fill_bytes(&mut seed);
    let ephemeral = x25519_dalek::StaticSecret::from(seed);
    let ephemeral_public = x25519_dalek::PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&x25519_dalek::PublicKey::from(*recipient));
    let key = box_key(shared.as_bytes(), ephemeral_public.as_bytes(), recipient);
    let cipher = ChaCha20Poly1305::new((&key).into());
    let body = cipher
        .encrypt(
            &Nonce::default(),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("chacha20poly1305 encryption cannot fail");
    let mut out = Vec::with_capacity(32 + body.len());
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&body);
    out
}

pub fn open_box(secret: &BoxSecret, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, BteError> {
    if sealed.len() < 32 + 16 {
        return Err(BteError::Wire("sealed box too short".into()));
    }
    let ephemeral_public: [u8; 32] = sealed[..32].try_into().unwrap();
    let shared = secret
        .0
        .diffie_hellman(&x25519_dalek::PublicKey::from(ephemeral_public));
    let key = box_key(shared.as_bytes(), &ephemeral_public, &secret.public());
    let cipher = ChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(
            &Nonce::default(),
            Payload {
                msg: &sealed[32..],
                aad,
            },
        )
        .map_err(|_| BteError::InvalidCiphertext("sealed box rejected".into()))
}

fn box_key(shared: &[u8; 32], ephemeral_public: &[u8; 32], recipient: &[u8; 32]) -> [u8; 32] {
    let mut info = Vec::with_capacity(64);
    info.extend_from_slice(ephemeral_public);
    info.extend_from_slice(recipient);
    let hk = Hkdf::<Sha256>::new(Some(BOX_SALT), shared);
    let mut key = [0u8; 32];
    hk.expand(&info, &mut key).expect("valid length");
    key
}

/// AAD for a private dealing's box: round, dealer, recipient box key.
pub fn box_aad(round: &[u8; 32], dealer: &IdentityKey, recipient_box: &[u8; 32]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(96);
    aad.extend_from_slice(round);
    aad.extend_from_slice(&dealer.encode());
    aad.extend_from_slice(recipient_box);
    aad
}

/// An identity from 32 seed bytes (for keystores) and back.
pub fn identity_from_bytes(bytes: &[u8]) -> Result<Identity, BteError> {
    Identity::decode(bytes).map_err(|_| BteError::Wire("identity key".into()))
}

pub fn identity_key_from_bytes(bytes: &[u8]) -> Result<IdentityKey, BteError> {
    IdentityKey::decode(bytes).map_err(|_| BteError::Wire("identity public key".into()))
}

/// The public half of an identity.
pub fn identity_key_of(identity: &Identity) -> IdentityKey {
    identity.public_key()
}

/// A fresh identity from 32 bytes of our entropy (an ed25519 seed).
pub fn generate_identity(rng: &mut impl ark_std::rand::Rng) -> Identity {
    let mut seed = [0u8; 32];
    rng.fill_bytes(&mut seed);
    Identity::decode(&seed[..]).expect("any 32 bytes are an ed25519 seed")
}

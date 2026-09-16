//! Withdrawals: how value leaves a namespace (decision 0005).
//!
//! A withdrawal is an ordinary R_op send whose hidden receiver is the fixed
//! `WITHDRAW` identifier. No key derives that identifier, so nobody can ever
//! claim the receipt on the ledger: the value is burned there the moment
//! the send is accepted. The withdrawer then discloses the receipt opening
//! to the settlement path, which checks it against the appended leaf, marks
//! the position consumed, and has the committee attest to the release on
//! the backing chain. The disclosure is signed by the account key so only
//! the sender can direct where the tokens go.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::account::{account_id, hex_32, hex_64, Namespace, SpendKey};
use crate::encoding::{fr_hex, fr_to_bytes};
use crate::trees::ReceiptOpening;
use crate::{Error, Fr, Result};

pub const ENVELOPE_WITHDRAWAL: u8 = 5;

/// The receiver identifier of every withdrawal receipt. Like the mint
/// sender, a tagged hash read as a field element.
pub fn withdraw_receiver() -> Fr {
    use ark_ff::PrimeField;
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(b"peal-links/v1/withdraw-receiver");
    Fr::from_le_bytes_mod_order(&d)
}

/// The signed disclosure that turns a finalized burn into a release.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WithdrawalClaim {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "fr_hex")]
    pub account: Fr,
    /// Receipt position of the burn on the ledger (the withdrawal id).
    pub position: u64,
    pub opening: ReceiptOpening,
    /// EVM recipient, 0x-prefixed lowercase hex.
    pub recipient: String,
    #[serde(with = "hex_32")]
    pub pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl WithdrawalClaim {
    fn signing_bytes(
        namespace: &Namespace,
        account: &Fr,
        position: u64,
        opening: &ReceiptOpening,
        recipient: &str,
        pubkey: &[u8; 32],
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(256);
        m.extend_from_slice(crate::account::ENVELOPE_MAGIC);
        m.push(ENVELOPE_WITHDRAWAL);
        m.extend_from_slice(namespace);
        m.extend_from_slice(&fr_to_bytes(account));
        m.extend_from_slice(&position.to_le_bytes());
        m.extend_from_slice(&opening.amount.to_le_bytes());
        m.extend_from_slice(&fr_to_bytes(&opening.sender));
        m.extend_from_slice(&fr_to_bytes(&opening.receiver));
        m.extend_from_slice(&fr_to_bytes(&opening.randomness));
        m.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        m.extend_from_slice(recipient.as_bytes());
        m.extend_from_slice(pubkey);
        m
    }

    pub fn sign(
        key: &SpendKey,
        namespace: Namespace,
        position: u64,
        opening: ReceiptOpening,
        recipient: String,
    ) -> Self {
        let account = key.account_id(&namespace);
        let pubkey = key.public().to_bytes();
        let recipient = recipient.to_lowercase();
        let signature = key.sign(&Self::signing_bytes(
            &namespace, &account, position, &opening, &recipient, &pubkey,
        ));
        Self {
            namespace,
            account,
            position,
            opening,
            recipient,
            pubkey,
            signature,
        }
    }

    /// Signature valid, signer owns `account`, and the opening is a
    /// withdrawal receipt sent by that account.
    pub fn verify(&self) -> Result<()> {
        if self.opening.sender != self.account || self.opening.receiver != withdraw_receiver() {
            return Err(Error::Wire(
                "opening is not a withdrawal receipt of this account".into(),
            ));
        }
        if !is_evm_address(&self.recipient) {
            return Err(Error::Wire("recipient is not an EVM address".into()));
        }
        let pk = VerifyingKey::from_bytes(&self.pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.account {
            return Err(Error::BadSignature);
        }
        pk.verify(
            &Self::signing_bytes(
                &self.namespace,
                &self.account,
                self.position,
                &self.opening,
                &self.recipient,
                &self.pubkey,
            ),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| Error::BadSignature)
    }
}

pub fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A withdrawal's canonical message for the gateway, as the committee
/// signs it (mirrors `PealLinksGateway.Withdrawal`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WithdrawalMessage {
    pub chain_id: u64,
    pub gateway: String,
    pub token: String,
    pub recipient: String,
    /// Base units, decimal string.
    pub amount: String,
    /// `keccak256(namespace || position_be64)`, hex.
    pub withdrawal_id: String,
    pub epoch: u64,
}

pub fn withdrawal_id(namespace: &Namespace, position: u64) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    let mut h = Keccak256::new();
    h.update(namespace);
    h.update(position.to_be_bytes());
    h.finalize().into()
}

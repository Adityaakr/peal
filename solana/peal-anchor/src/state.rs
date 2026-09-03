//! Account layouts.
//!
//! Hand-encoded rather than borsh-derived, for the same reason
//! `packages/sdk/src/anchor.ts` hand-encodes its EVM calldata: the layouts are
//! a handful of fixed-width fields, and writing them out means the wire format
//! is legible in one screen instead of implied by a derive macro. It also keeps
//! the dependency tree at exactly one crate, which matters for a program whose
//! binary size and audit surface are both worth keeping small.

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// First byte of every owned account, so an account of one kind can never be
/// read as another. Solana does not type accounts for you; passing the config
/// account where a reveal account is expected is a normal thing for a caller to
/// attempt, and without a tag it would deserialize into plausible garbage.
pub const TAG_CONFIG: u8 = 1;
pub const TAG_REVEAL: u8 = 2;

pub const CONFIG_SEED: &[u8] = b"config";
pub const REVEAL_SEED: &[u8] = b"reveal";

/// `TAG_CONFIG || coordinator(32)`
pub const CONFIG_LEN: usize = 1 + 32;

/// `TAG_REVEAL || condition_id(32) || merkle_root(32) || leaf_count(4, le)`
pub const REVEAL_LEN: usize = 1 + 32 + 32 + 4;

/// The single authority allowed to publish reveal roots.
///
/// Mirrors `address public immutable coordinator` in `contracts/src/BteAnchor.sol`.
/// Unlike the Solidity version this is stored rather than immutable, because a
/// Solana program's data account has to be created before the program can be
/// used and there is nowhere to put a constructor argument. It is written once
/// by `Initialize` and there is deliberately no instruction that rewrites it:
/// rotating the coordinator means deploying a new config, which is the same
/// blast radius as redeploying the immutable Solidity contract.
pub struct Config {
    pub coordinator: Pubkey,
}

impl Config {
    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < CONFIG_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0] = TAG_CONFIG;
        dst[1..33].copy_from_slice(self.coordinator.as_ref());
        Ok(())
    }

    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < CONFIG_LEN || src[0] != TAG_CONFIG {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            coordinator: Pubkey::try_from(&src[1..33])
                .map_err(|_| ProgramError::InvalidAccountData)?,
        })
    }
}

/// One anchored reveal: the root, and the leaf count that fixes the tree's shape.
///
/// The count is not redundant: a promotion tree cannot be walked without
/// knowing how wide each level was, and it is what bounds a claimed position to
/// the batch that actually existed. It is a shape hint and a bound, not a
/// second commitment. `merkle::verify_inclusion` documents exactly how much it
/// does and does not pin.
pub struct Reveal {
    /// The condition this root belongs to, stored rather than implied.
    ///
    /// It is already encoded in the account's address, so this looks redundant.
    /// It is not: recovering it from the address means `find_program_address`,
    /// which searches bump seeds and costs between one and a few hundred
    /// sha256 rounds depending on the id. Measured on a local validator that
    /// search dominated `VerifyInclusion` entirely, swamping the tree walk it
    /// was supposed to be measuring and making the cost vary by thousands of
    /// compute units between conditions for no reason a caller can predict.
    ///
    /// Thirty-two bytes of rent buys a read path that does no derivation at
    /// all: an account this program owns, carrying `TAG_REVEAL` and the
    /// condition asked about, can only have been written by `reveal_root`,
    /// which writes exclusively at the canonical PDA. Writes still pay for
    /// canonicity; reads no longer do.
    pub condition_id: [u8; 32],
    pub merkle_root: [u8; 32],
    pub leaf_count: u32,
}

impl Reveal {
    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < REVEAL_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0] = TAG_REVEAL;
        dst[1..33].copy_from_slice(&self.condition_id);
        dst[33..65].copy_from_slice(&self.merkle_root);
        dst[65..69].copy_from_slice(&self.leaf_count.to_le_bytes());
        Ok(())
    }

    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < REVEAL_LEN || src[0] != TAG_REVEAL {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut condition_id = [0u8; 32];
        condition_id.copy_from_slice(&src[1..33]);
        let mut merkle_root = [0u8; 32];
        merkle_root.copy_from_slice(&src[33..65]);
        Ok(Self {
            condition_id,
            merkle_root,
            leaf_count: u32::from_le_bytes([src[65], src[66], src[67], src[68]]),
        })
    }
}

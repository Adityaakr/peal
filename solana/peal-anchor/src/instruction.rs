//! The instruction wire format, decoded by hand.
//!
//! Every instruction is a one-byte tag followed by fixed-width fields, with at
//! most one variable-length field and it always comes last. That rule is what
//! makes the decoder below a series of range checks instead of a parser, and it
//! is worth keeping if this grows.
//!
//! `condition_id` is 32 bytes throughout. Peal condition ids are strings; the
//! bytes here are `sha256(utf8(condition_id))`, exactly what
//! `conditionIdToBytes32` in `packages/sdk/src/anchor.ts` sends to the EVM
//! anchor. Using the same derivation on both chains means one condition has one
//! identity no matter where it was anchored.

use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::state::{CONFIG_SEED, REVEAL_SEED};

pub const TAG_INITIALIZE: u8 = 0;
pub const TAG_COMMIT: u8 = 1;
pub const TAG_REVEAL_ROOT: u8 = 2;
pub const TAG_VERIFY_INCLUSION: u8 = 3;

/// A proof deeper than this cannot be honest: 32 levels of a binary tree is
/// 4.29e9 leaves, past what `leaf_count: u32` can even name. The bound exists
/// so a malformed instruction is rejected by a length check rather than by
/// running out of compute halfway up a fabricated tree.
pub const MAX_PROOF_DEPTH: usize = 32;

pub enum PealInstruction<'a> {
    /// Create the config account and record the coordinator.
    ///
    /// Accounts: `[payer(signer, writable), config(writable), system_program]`
    Initialize { coordinator: Pubkey },

    /// Record that a ciphertext was anchored to a condition.
    ///
    /// Accounts: none. Open to anyone, exactly like `BteAnchor.commit`.
    Commit {
        condition_id: [u8; 32],
        ct_hash: [u8; 32],
    },

    /// Publish the reveal root for a condition. Once per condition.
    ///
    /// Accounts: `[coordinator(signer, writable), config, reveal(writable), system_program]`
    RevealRoot {
        condition_id: [u8; 32],
        merkle_root: [u8; 32],
        leaf_count: u32,
    },

    /// Check a payload against an anchored root. Reads only.
    ///
    /// Accounts: `[reveal]`
    VerifyInclusion {
        condition_id: [u8; 32],
        position: u32,
        path: &'a [u8],
        payload: &'a [u8],
    },
}

fn take<'a>(src: &'a [u8], at: usize, n: usize) -> Result<&'a [u8], ProgramError> {
    src.get(at..at + n)
        .ok_or(ProgramError::InvalidInstructionData)
}

fn arr32(src: &[u8], at: usize) -> Result<[u8; 32], ProgramError> {
    let mut out = [0u8; 32];
    out.copy_from_slice(take(src, at, 32)?);
    Ok(out)
}

fn u32_le(src: &[u8], at: usize) -> Result<u32, ProgramError> {
    let b = take(src, at, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

impl<'a> PealInstruction<'a> {
    pub fn unpack(data: &'a [u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;

        match tag {
            TAG_INITIALIZE => Ok(Self::Initialize {
                coordinator: Pubkey::try_from(take(rest, 0, 32)?)
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            }),

            TAG_COMMIT => Ok(Self::Commit {
                condition_id: arr32(rest, 0)?,
                ct_hash: arr32(rest, 32)?,
            }),

            TAG_REVEAL_ROOT => Ok(Self::RevealRoot {
                condition_id: arr32(rest, 0)?,
                merkle_root: arr32(rest, 32)?,
                leaf_count: u32_le(rest, 64)?,
            }),

            TAG_VERIFY_INCLUSION => {
                let condition_id = arr32(rest, 0)?;
                let position = u32_le(rest, 32)?;
                let depth = *rest.get(36).ok_or(ProgramError::InvalidInstructionData)? as usize;
                if depth > MAX_PROOF_DEPTH {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let path = take(rest, 37, depth * 32)?;
                // The payload is whatever is left. It is the only
                // variable-length field and it is last, so no length prefix is
                // needed and none is trusted.
                let payload = &rest[37 + depth * 32..];
                Ok(Self::VerifyInclusion {
                    condition_id,
                    position,
                    path,
                    payload,
                })
            }

            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

pub fn config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

pub fn reveal_pda(program_id: &Pubkey, condition_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[REVEAL_SEED, condition_id], program_id)
}

// ---------------------------------------------------------------------------
// Client-side builders.
//
// These live in the program crate on purpose. The encoder and the decoder
// disagreeing is the single most likely way this program breaks, and the
// cheapest defence is that they cannot be edited in separate repositories.
// ---------------------------------------------------------------------------

pub fn initialize(program_id: &Pubkey, payer: &Pubkey, coordinator: &Pubkey) -> Instruction {
    let (config, _) = config_pda(program_id);
    let mut data = Vec::with_capacity(33);
    data.push(TAG_INITIALIZE);
    data.extend_from_slice(coordinator.as_ref());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

pub fn commit(program_id: &Pubkey, condition_id: &[u8; 32], ct_hash: &[u8; 32]) -> Instruction {
    let mut data = Vec::with_capacity(65);
    data.push(TAG_COMMIT);
    data.extend_from_slice(condition_id);
    data.extend_from_slice(ct_hash);
    Instruction {
        program_id: *program_id,
        accounts: vec![],
        data,
    }
}

pub fn reveal_root(
    program_id: &Pubkey,
    coordinator: &Pubkey,
    condition_id: &[u8; 32],
    merkle_root: &[u8; 32],
    leaf_count: u32,
) -> Instruction {
    let (config, _) = config_pda(program_id);
    let (reveal, _) = reveal_pda(program_id, condition_id);
    let mut data = Vec::with_capacity(69);
    data.push(TAG_REVEAL_ROOT);
    data.extend_from_slice(condition_id);
    data.extend_from_slice(merkle_root);
    data.extend_from_slice(&leaf_count.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*coordinator, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(reveal, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

pub fn verify_inclusion(
    program_id: &Pubkey,
    condition_id: &[u8; 32],
    position: u32,
    path: &[[u8; 32]],
    payload: &[u8],
) -> Instruction {
    let (reveal, _) = reveal_pda(program_id, condition_id);
    let mut data = Vec::with_capacity(37 + path.len() * 32 + payload.len());
    data.push(TAG_VERIFY_INCLUSION);
    data.extend_from_slice(condition_id);
    data.extend_from_slice(&position.to_le_bytes());
    data.push(path.len() as u8);
    for h in path {
        data.extend_from_slice(h);
    }
    data.extend_from_slice(payload);
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new_readonly(reveal, false)],
        data,
    }
}

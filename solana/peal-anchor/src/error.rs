//! Program errors.
//!
//! Numbered explicitly and never renumbered, because a client that maps error
//! codes to messages will keep using the old numbers long after a redeploy.

use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PealError {
    /// A passed account is not the PDA its seeds derive to.
    WrongPda = 0,
    /// The coordinator did not sign.
    NotCoordinator = 1,
    /// A root is already anchored for this condition.
    AlreadyRevealed = 2,
    /// The root is all zeroes, which is how "not revealed" is spelled.
    ZeroRoot = 3,
    /// A tree with no leaves has nothing to prove membership in.
    EmptyTree = 4,
    /// The payload is not at that position under the anchored root.
    InclusionProofFailed = 5,
    /// An account that should belong to this program does not.
    WrongOwner = 6,
}

impl From<PealError> for ProgramError {
    fn from(e: PealError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

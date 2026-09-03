//! Peal anchor, for Solana.
//!
//! Anchors a Peal reveal root where anyone can check a revealed payload against
//! what the committee published, and verifies inclusion proofs onchain.
//!
//! This is the Solana counterpart of `contracts/src/BteAnchor.sol`, with one
//! capability the Solidity version does not have. `BteAnchor` stores a root and
//! leaves proof checking to `bte-sdk`'s `verifyAnchor` offchain. Here the proof
//! check runs onchain, because sha256 is a syscall on Solana and a tree walk
//! costs a few thousand compute units. That means another Solana program can
//! make a decision that depends on a specific bid having been in a specific
//! sealed batch, by CPI, without trusting an offchain verifier.
//!
//! ## What it deliberately does not do
//!
//! **It holds no funds.** There is no escrow, no allocation, no settlement.
//! Every account this program owns is 37 bytes of root and count. If this
//! program is wrong the worst case is that an anchor is unusable, not that
//! money moves.
//!
//! **It does not verify threshold decryption shares.** That needs BLS12-381
//! pairings. Solana's pairing syscall arrives with SIMD-0388, whose
//! `sol_curve_pairing_map` takes at most 8 pairs; Peal's share check is
//! `e(pd_j, -g_2) * prod_i e(ct_{i,0}, v_j^i) == 1`, which is `1 + B` terms and
//! therefore 65 at `B = 64`. That is nine syscalls plus Fp12 accumulation, at
//! compute costs the SIMD does not specify, on a feature gate that is not
//! confirmed on mainnet. Share verification stays where it was measured, on
//! Ethereum at 6.5M gas under EIP-2537. See `docs/auctionkit/decisions/0003`.
//!
//! **It does not enforce the reveal deadline.** Nothing here checks a clock. A
//! root appears when the coordinator sends one. That is the same honest
//! position the EVM anchor is in, and it is recorded as a live invariant in
//! `.prism/project-model.md`: the deadline is asserted by the coordinator, not
//! enforced by the protocol. Anchoring on a second chain does not change it.
//!
//! ## The property that matters
//!
//! The root computed here must be byte-identical to the one
//! `crates/bte-coordinator/src/merkle.rs` computes. See `merkle.rs`.

pub mod error;
pub mod instruction;
pub mod merkle;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entry {
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };

    entrypoint!(process_instruction);

    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}

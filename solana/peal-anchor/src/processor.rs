//! Instruction handlers.
//!
//! Solana hands a program a list of accounts chosen by the caller and checks
//! almost nothing about them. Every handler below therefore re-derives the PDA
//! it expects and compares, rather than trusting the address it was given. That
//! is the difference between a mapping lookup in Solidity, where the key
//! determines the slot, and an account reference here, where the caller
//! determines both.

use solana_system_interface::{instruction as system_instruction, program as system_program};

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    log::sol_log_data,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::{
    error::PealError,
    instruction::PealInstruction,
    merkle,
    state::{Config, Reveal, CONFIG_LEN, CONFIG_SEED, REVEAL_LEN, REVEAL_SEED},
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match PealInstruction::unpack(data)? {
        PealInstruction::Initialize { coordinator } => {
            initialize(program_id, accounts, coordinator)
        }
        PealInstruction::Commit {
            condition_id,
            ct_hash,
        } => commit(&condition_id, &ct_hash),
        PealInstruction::RevealRoot {
            condition_id,
            merkle_root,
            leaf_count,
        } => reveal_root(program_id, accounts, &condition_id, &merkle_root, leaf_count),
        PealInstruction::VerifyInclusion {
            condition_id,
            position,
            path,
            payload,
        } => verify_inclusion(program_id, accounts, &condition_id, position, path, payload),
    }
}

/// Create a PDA this program owns, tolerating an address someone has already
/// sent lamports to.
///
/// `create_account` fails outright on an account with a non-zero balance, and
/// a PDA's address is public the moment the condition id is. Anyone can compute
/// where a future reveal will live and send it one lamport, which under the
/// naive implementation would permanently block that condition from ever being
/// anchored. It costs a griefer almost nothing and it is not theoretical, so
/// the funded case falls back to transfer, allocate and assign, which is what
/// `create_account` does internally anyway.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(space);
    let balance = target.lamports();

    if balance == 0 {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                target.key,
                rent,
                space as u64,
                program_id,
            ),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        )
    } else {
        if balance < rent {
            invoke(
                &system_instruction::transfer(payer.key, target.key, rent - balance),
                &[payer.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target.key, space as u64),
            &[target.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(target.key, program_id),
            &[target.clone(), system.clone()],
            &[seeds],
        )
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], coordinator: Pubkey) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system.key != &system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (expected, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected {
        return Err(PealError::WrongPda.into());
    }
    // Initialising twice would silently replace the coordinator, which is the
    // one thing this account exists to make hard.
    if config.owner == program_id && !config.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    create_pda(
        payer,
        config,
        system,
        CONFIG_LEN,
        &[CONFIG_SEED, &[bump]],
        program_id,
    )?;

    Config { coordinator }.pack(&mut config.try_borrow_mut_data()?)?;
    msg!("peal: initialized");
    Ok(())
}

/// Record a ciphertext against a condition.
///
/// Takes no accounts and writes no state, exactly like `BteAnchor.commit`,
/// where the event is the record. On Solana the analogue of an event is a
/// program data log, which is a real difference worth stating plainly: logs are
/// retrievable from a transaction but RPC providers prune history, so a commit
/// is durable only for as long as someone keeps the ledger or indexes the log.
/// If a commit ever needs to be provable years later, it needs an account, not
/// a log. Today nothing in Peal reads commits back, so this stays cheap.
fn commit(condition_id: &[u8; 32], ct_hash: &[u8; 32]) -> ProgramResult {
    sol_log_data(&[b"peal:commit", condition_id, ct_hash]);
    Ok(())
}

fn reveal_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    condition_id: &[u8; 32],
    merkle_root: &[u8; 32],
    leaf_count: u32,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let coordinator = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let reveal = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    if !coordinator.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system.key != &system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    // A config account this program does not own could have been fabricated by
    // the caller with any coordinator key inside it.
    if config.owner != program_id {
        return Err(PealError::WrongOwner.into());
    }
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config {
        return Err(PealError::WrongPda.into());
    }
    if Config::unpack(&config.try_borrow_data()?)?.coordinator != *coordinator.key {
        return Err(PealError::NotCoordinator.into());
    }

    // Zero is how "no root yet" reads on the EVM anchor, and an anchored zero
    // would be indistinguishable from an unanchored condition.
    if merkle_root == &[0u8; 32] {
        return Err(PealError::ZeroRoot.into());
    }
    // A root over zero leaves is sha256(""), which proves nothing and would
    // make verify_inclusion unreachable for that condition.
    if leaf_count == 0 {
        return Err(PealError::EmptyTree.into());
    }

    let (expected_reveal, bump) =
        Pubkey::find_program_address(&[REVEAL_SEED, condition_id], program_id);
    if reveal.key != &expected_reveal {
        return Err(PealError::WrongPda.into());
    }
    // Once per condition. The account existing is the flag; there is no
    // instruction that overwrites it.
    if reveal.owner == program_id && !reveal.data_is_empty() {
        return Err(PealError::AlreadyRevealed.into());
    }

    create_pda(
        coordinator,
        reveal,
        system,
        REVEAL_LEN,
        &[REVEAL_SEED, condition_id, &[bump]],
        program_id,
    )?;

    Reveal {
        condition_id: *condition_id,
        merkle_root: *merkle_root,
        leaf_count,
    }
    .pack(&mut reveal.try_borrow_mut_data()?)?;

    sol_log_data(&[b"peal:reveal", condition_id, merkle_root]);
    Ok(())
}

/// Check that `payload` sits at `position` under the anchored root.
///
/// Fails the instruction when it does not, rather than returning a boolean.
/// A program calling this by CPI wants the whole transaction to stop on a bad
/// proof; making the caller remember to check a return value is how that gets
/// forgotten once.
fn verify_inclusion(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    condition_id: &[u8; 32],
    position: u32,
    path: &[u8],
    payload: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let reveal = next_account_info(iter)?;

    // Deliberately no `find_program_address` here. Ownership plus the tag plus
    // the stored condition id already identify the record uniquely, because
    // `reveal_root` is the only writer and it writes only at the canonical PDA.
    // Re-deriving the address would add a bump-seed search whose cost varies
    // per condition and, measured, was larger than the proof check itself.
    if reveal.owner != program_id {
        return Err(PealError::WrongOwner.into());
    }

    let data = reveal.try_borrow_data()?;
    if data.len() < REVEAL_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let anchored = Reveal::unpack(&data)?;
    if &anchored.condition_id != condition_id {
        return Err(PealError::WrongPda.into());
    }

    // The path arrives as flat bytes and is a whole number of hashes by
    // construction, since the decoder read it as `depth * 32`.
    let hashes: Vec<[u8; 32]> = path
        .chunks_exact(32)
        .map(|c| {
            let mut h = [0u8; 32];
            h.copy_from_slice(c);
            h
        })
        .collect();

    if !merkle::verify_inclusion(
        payload,
        position,
        anchored.leaf_count,
        &hashes,
        &anchored.merkle_root,
    ) {
        return Err(PealError::InclusionProofFailed.into());
    }

    msg!("peal: inclusion ok at {}", position);
    Ok(())
}

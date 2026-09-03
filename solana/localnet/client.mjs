// Instruction builders, mirroring solana/peal-anchor/src/instruction.rs.
//
// The encoder here and the decoder there disagreeing is the most likely way
// this program breaks, so the two files should be read side by side when
// either changes.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { concat, sha256, u32le } from './merkle.mjs';

export const TAG = { INITIALIZE: 0, COMMIT: 1, REVEAL_ROOT: 2, VERIFY_INCLUSION: 3 };

/** Program error codes, from src/error.rs. Never renumbered. */
export const ERR = {
  0: 'WrongPda',
  1: 'NotCoordinator',
  2: 'AlreadyRevealed',
  3: 'ZeroRoot',
  4: 'EmptyTree',
  5: 'InclusionProofFailed',
  6: 'WrongOwner',
};

/** Peal condition ids are strings; onchain they are sha256 of the utf8 bytes,
 *  the same derivation packages/sdk/src/anchor.ts uses for the EVM anchor. */
export const conditionId = (s) => sha256(new TextEncoder().encode(s));

export const configPda = (programId) =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];

export const revealPda = (programId, cid) =>
  PublicKey.findProgramAddressSync([Buffer.from('reveal'), Buffer.from(cid)], programId)[0];

export const initialize = (programId, payer, coordinator) =>
  new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(new Uint8Array([TAG.INITIALIZE]), coordinator.toBytes())),
  });

export const commit = (programId, cid, ctHash) =>
  new TransactionInstruction({
    programId,
    keys: [],
    data: Buffer.from(concat(new Uint8Array([TAG.COMMIT]), cid, ctHash)),
  });

export const revealRoot = (programId, coordinator, cid, root, leafCount) =>
  new TransactionInstruction({
    programId,
    keys: [
      { pubkey: coordinator, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: revealPda(programId, cid), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(new Uint8Array([TAG.REVEAL_ROOT]), cid, root, u32le(leafCount))),
  });

export const verifyInclusion = (programId, cid, position, path, payload) =>
  new TransactionInstruction({
    programId,
    keys: [{ pubkey: revealPda(programId, cid), isSigner: false, isWritable: false }],
    data: Buffer.from(
      concat(new Uint8Array([TAG.VERIFY_INCLUSION]), cid, u32le(position),
             new Uint8Array([path.length]), ...path, payload),
    ),
  });

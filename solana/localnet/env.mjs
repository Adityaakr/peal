// Shared localnet setup.
//
// The coordinator key is derived from a constant string so both harnesses can
// run against the same ledger without one of them ending up as a stranger to
// the config account. It is a localnet test key and nothing else: it holds no
// value, is not used anywhere outside these two scripts, and is regenerated
// from the seed on every run rather than stored.
import { Connection, Keypair } from '@solana/web3.js';
import { sha256 } from './merkle.mjs';

export const RPC = process.env.PEAL_RPC ?? 'http://127.0.0.1:8899';

export const conn = new Connection(RPC, 'confirmed');

export const coordinator = Keypair.fromSeed(
  sha256(new TextEncoder().encode('peal-anchor-localnet-test-only')),
);

/** Unique per run, so a harness can be re-run against a live ledger. */
export const nonce = String(Date.now());

export function programId() {
  const id = process.argv[2] ?? process.env.PEAL_PROGRAM_ID;
  if (!id) {
    console.error('usage: node <script>.mjs <PROGRAM_ID>   (or set PEAL_PROGRAM_ID)');
    process.exit(2);
  }
  return id;
}

export async function fund(pubkey, sol = 50) {
  await conn.confirmTransaction(await conn.requestAirdrop(pubkey, sol * 1e9), 'confirmed');
}

/** The program's own compute usage for a confirmed signature. */
export async function computeUnits(signature, programIdStr) {
  const tx = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  for (const line of tx.meta.logMessages) {
    const m = line.match(/consumed (\d+) of \d+ compute units/);
    if (m && line.includes(programIdStr)) return Number(m[1]);
  }
  return null;
}

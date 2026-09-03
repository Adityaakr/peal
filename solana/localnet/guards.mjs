// Every guard in the program, asserted against a running validator.
//
// The unit tests in src/merkle.rs prove the tree agrees with the coordinator.
// They cannot prove the program refuses what it should refuse, because the
// refusals live in account ownership, signer checks and PDA derivation, none of
// which exist outside a runtime. So these run onchain.
//
//   solana-test-validator --reset
//   cargo-build-sbf --arch v3
//   solana program deploy target/deploy/peal_anchor.so
//   node guards.mjs <PROGRAM_ID>
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as peal from './client.mjs';
import { leaf, proof, root } from './merkle.mjs';
import { computeUnits, conn, coordinator, fund, nonce, programId } from './env.mjs';

const PID = new PublicKey(programId());
const mallory = Keypair.generate();
const PAYLOAD = new Uint8Array(200).fill(7);

let failures = 0;
const send = (ix, signer = coordinator) =>
  sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: 'confirmed' });

function describeError(e) {
  const logs = (e.transactionLogs ?? []).join('\n');
  const custom = logs.match(/custom program error: 0x([0-9a-f]+)/);
  if (custom) {
    const code = parseInt(custom[1], 16);
    return `${peal.ERR[code] ?? 'Unknown'} (0x${custom[1]})`;
  }
  const failed = logs.match(/failed: (.*)$/m);
  return (failed ? failed[1] : e.message).split('\n')[0].slice(0, 72);
}

async function rejects(label, fn) {
  try {
    await fn();
    failures++;
    console.log(`  FAIL  ${label}\n          was ACCEPTED but should have been rejected`);
  } catch (e) {
    console.log(`  ok    ${label}\n          ${describeError(e)}`);
  }
}

async function accepts(label, fn) {
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}\n          ${describeError(e)}`);
  }
}

await fund(coordinator.publicKey);
await fund(mallory.publicKey);

console.log('\nconfig');
if ((await conn.getAccountInfo(peal.configPda(PID))) === null) {
  await accepts('the config is created once', () =>
    send(peal.initialize(PID, coordinator.publicKey, coordinator.publicKey)));
} else {
  console.log('  --    config already present on this ledger, skipping first-init');
}
await rejects('a second initialize cannot replace the coordinator', () =>
  send(peal.initialize(PID, coordinator.publicKey, mallory.publicKey)));

console.log('\nreveal authority');
const cid = peal.conditionId(`guards-${nonce}`);
const leaves = Array.from({ length: 8 }, (_, i) => leaf(i, PAYLOAD));
const r = root(leaves);

await rejects('a stranger cannot publish a root', () =>
  send(peal.revealRoot(PID, mallory.publicKey, cid, r, 8), mallory));
await rejects('a zero root is refused, because zero means unrevealed', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, cid, new Uint8Array(32), 8)));
await rejects('an empty tree is refused', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, cid, r, 0)));
await accepts('the coordinator publishes the root', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, cid, r, 8)));
await rejects('the same condition cannot be revealed twice', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, cid, r, 8)));

console.log('\ninclusion');
const path = proof(leaves, 3);
await accepts('a real payload at its real position verifies', () =>
  send(peal.verifyInclusion(PID, cid, 3, path, PAYLOAD)));
await rejects('a tampered payload is rejected', () =>
  send(peal.verifyInclusion(PID, cid, 3, path, new Uint8Array(200).fill(8))));
await rejects('the right payload at the wrong position is rejected', () =>
  send(peal.verifyInclusion(PID, cid, 4, path, PAYLOAD)));
await rejects('a padded proof is rejected, not ignored', () =>
  send(peal.verifyInclusion(PID, cid, 3, [...path, new Uint8Array(32).fill(255)], PAYLOAD)));
await rejects('a truncated proof is rejected', () =>
  send(peal.verifyInclusion(PID, cid, 3, path.slice(0, -1), PAYLOAD)));
await rejects('a position beyond the batch is rejected', () =>
  send(peal.verifyInclusion(PID, cid, 99, path, PAYLOAD)));
await rejects('an unanchored condition has no record to read', () =>
  send(peal.verifyInclusion(PID, peal.conditionId(`never-anchored-${nonce}`), 3, path, PAYLOAD)));

// The check that replaced PDA re-derivation on the read path. Point the
// instruction at a real, correctly-owned reveal account while naming a
// different condition in the data. Without the stored condition id this would
// verify against the wrong batch's root, which is the whole reason the id is
// written into the account rather than left implied by the address.
const otherCid = peal.conditionId(`decoy-${nonce}`);
await accepts('a second condition is anchored', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, otherCid, r, 8)));
await rejects('an account whose stored condition differs from the named one is rejected', () => {
  const ix = peal.verifyInclusion(PID, otherCid, 3, path, PAYLOAD);
  ix.keys = [{ pubkey: peal.revealPda(PID, cid), isSigner: false, isWritable: false }];
  return send(ix);
});

console.log('\ngriefing');
// A reveal PDA's address is public as soon as the condition id is, so anyone
// can send it lamports before the coordinator gets there. create_account fails
// outright on a funded address; the program falls back to allocate and assign.
const cid2 = peal.conditionId(`prefunded-${nonce}`);
const dust = await conn.getMinimumBalanceForRentExemption(0);
const needed = await conn.getMinimumBalanceForRentExemption(69);
await sendAndConfirmTransaction(
  conn,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: mallory.publicKey,
    toPubkey: peal.revealPda(PID, cid2),
    lamports: dust,
  })),
  [mallory],
  { commitment: 'confirmed' },
);
console.log(`  --    a stranger front-ran the PDA with ${dust} lamports; the record needs ${needed}`);
await accepts('a pre-funded reveal PDA can still be anchored', () =>
  send(peal.revealRoot(PID, coordinator.publicKey, cid2, r, 8)));

console.log(failures === 0 ? '\nall guards hold\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

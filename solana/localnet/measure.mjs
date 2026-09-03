// Compute cost of every instruction, measured on a validator rather than
// estimated.
//
// The reason this exists: the argument for anchoring Peal on Solana rests on
// inclusion proofs being cheap enough to check onchain, which is a claim about
// compute units and therefore worth a number rather than an adjective.
//
//   solana-test-validator --reset
//   cargo-build-sbf --arch v3
//   solana program deploy target/deploy/peal_anchor.so
//   node measure.mjs <PROGRAM_ID>
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as peal from './client.mjs';
import { leaf, proof, root, sha256 } from './merkle.mjs';
import { computeUnits, conn, coordinator, fund, nonce, programId } from './env.mjs';

const ID = programId();
const PID = new PublicKey(ID);
// 200 bytes, the payload size the coordinator's own scaling table uses.
const PAYLOAD = new Uint8Array(200).fill(7);

const send = (ix) =>
  sendAndConfirmTransaction(conn, new Transaction().add(ix), [coordinator], { commitment: 'confirmed' });
const cu = (sig) => computeUnits(sig, ID);

await fund(coordinator.publicKey);

console.log('');
if ((await conn.getAccountInfo(peal.configPda(PID))) === null) {
  console.log(`Initialize        ${await cu(await send(peal.initialize(PID, coordinator.publicKey, coordinator.publicKey)))} CU`);
}
console.log(`Commit            ${await cu(await send(peal.commit(PID, peal.conditionId(`c-${nonce}`), sha256(Buffer.from('ct')))))} CU`);

console.log('');
console.log('   batch   depth   RevealRoot   VerifyInclusion');
for (const b of [1, 2, 4, 8, 16, 64, 256, 512, 4096]) {
  const cid = peal.conditionId(`b${b}-${nonce}`);
  const leaves = Array.from({ length: b }, (_, i) => leaf(i, PAYLOAD));
  const r = root(leaves);
  const position = b - 1;
  const path = proof(leaves, position);

  const wrote = await cu(await send(peal.revealRoot(PID, coordinator.publicKey, cid, r, b)));
  const read = await cu(await send(peal.verifyInclusion(PID, cid, position, path, PAYLOAD)));

  console.log(
    `   ${String(b).padStart(5)}   ${String(path.length).padStart(5)}   ${String(wrote).padStart(10)}   ${String(read).padStart(15)}`,
  );
}
console.log(`
RevealRoot's spread is find_program_address searching bump seeds, quantised at
about 1500 CU per iteration, and depends only on the condition id. It is not
a function of batch size. VerifyInclusion does no derivation, so it is flat at
about 1355 CU plus 170 per level.
`);

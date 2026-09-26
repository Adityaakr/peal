// What the explorer's encrypted-mempool page does, without the DOM, against a
// v1 committee: seal an order to a `mempool` condition with bte-sdk, commit
// the ciphertext hash through the relayer, wait for the reveal, and check the
// settler's executeBatch on chain: the batch's merkle root is the one the
// contract accepted, and the order filled.
//
// Env: RELAYER_URL, COORDINATOR_URL, RPC_URL.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { BteClient } = await import(join(root, 'packages', 'sdk', 'dist', 'index.js'));
const agentsRequire = createRequire(join(root, 'packages', 'mempool-agents', 'package.json'));
const { encodeAbiParameters, sha256, toBytes, createPublicClient, http } = agentsRequire('viem');

const RELAYER = process.env.RELAYER_URL ?? 'http://127.0.0.1:8799';
const COORD = process.env.COORDINATOR_URL ?? 'http://127.0.0.1:8091';
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8546';
const ROUND_SECS = 4;

const ORDER_PARAMS = [
  { name: 'trader', type: 'address' },
  { name: 'baseToQuote', type: 'bool' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'minOut', type: 'uint256' },
  { name: 'to', type: 'address' },
];

async function relayer(path, body) {
  const res = await fetch(`${RELAYER}${path}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`relayer ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function fail(msg) {
  console.error(`mempool-v1 FAIL: ${msg}`);
  process.exit(1);
}

const cfg = await relayer('/config');
const client = new BteClient({ url: COORD });
const committee = await client.committee();
console.log(`committee ${committee.id.slice(0, 16)} scheme=${committee.scheme} n=${committee.n} t=${committee.t}`);
if (committee.scheme !== 'v1') fail(`expected a v1 committee, got ${committee.scheme}`);

await relayer('/prepare', {});
const conditionId = await client.condition({ in: ROUND_SECS, tag: 'mempool' });
console.log(`condition ${conditionId} fires in ${ROUND_SECS}s`);

// Pay 1,000 mUSDC for mETH at any price above zero (the demo pool is deep).
const amountIn = 1_000n * 10n ** 18n;
const payload = encodeAbiParameters(ORDER_PARAMS, [cfg.relayer, true, amountIn, 1n, cfg.relayer]);
const payloadBytes = Uint8Array.from(Buffer.from(payload.slice(2), 'hex'));
const { ctHash, sealedB64 } = await client.seal(payloadBytes, conditionId);
const sealed = Buffer.from(sealedB64, 'base64');
if (sealed.subarray(0, 4).toString() !== 'BTE1') fail('the SDK did not produce a v1 ciphertext');
console.log(`sealed order: ct_hash ${ctHash.slice(0, 16)}… (${sealed.length} bytes, BTE1)`);
const commit = await relayer('/commit', { conditionId, ctHash });
console.log(`committed on chain: ${commit.txHash}`);

const deadline = Date.now() + 120_000;
let reveal = null;
while (Date.now() < deadline) {
  reveal = await client.reveal(conditionId);
  if (reveal) break;
  await new Promise((r) => setTimeout(r, 750));
}
if (!reveal) fail('no reveal within 120s');
const real = reveal.slots.filter((s) => !s.isDummy);
const verified = reveal.shares.filter((s) => s.verified).length;
console.log(`revealed: ${real.length} real + ${reveal.slots.length - real.length} decoy, ${verified} verified shares, root ${reveal.merkleRoot.slice(0, 16)}…`);
if (real.length !== 1 || !real[0].valid) fail('the sealed order did not open');
if (Buffer.from(real[0].payload).toString('hex') !== payload.slice(2)) fail('revealed payload differs from the sealed order');
if (verified < committee.t) fail(`only ${verified} verified shares, threshold ${committee.t}`);

let result = { done: false };
const settleDeadline = Date.now() + 90_000;
while (Date.now() < settleDeadline) {
  result = await relayer(`/peal-result?conditionId=${encodeURIComponent(conditionId)}`);
  if (result.done) break;
  await new Promise((r) => setTimeout(r, 750));
}
if (!result.done) fail('the settler did not execute the batch within 90s');
console.log(`settled: executeBatch ${result.txHash}, ${result.realCount} real, fills ${JSON.stringify(result.fills)}`);
if (result.realCount !== 1) fail(`executeBatch reported ${result.realCount} real orders`);
if (result.fills.length !== 1) fail('the order did not fill');

// The chain's word, not the coordinator's: settledRoot equals the reveal root.
const pub = createPublicClient({ transport: http(RPC) });
const settled = await pub.readContract({
  address: cfg.pealMempool ?? cfg.contracts?.pealMempool,
  abi: [{ type: 'function', name: 'settledRoot', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }],
  functionName: 'settledRoot',
  args: [sha256(toBytes(conditionId))],
});
if (settled.toLowerCase() !== `0x${reveal.merkleRoot.replace(/^0x/, '')}`.toLowerCase()) {
  fail(`on-chain settledRoot ${settled} differs from the reveal root ${reveal.merkleRoot}`);
}
console.log(`mempool-v1 PASS: on-chain settledRoot matches the v1 reveal's merkle root (${settled.slice(0, 16)}…)`);

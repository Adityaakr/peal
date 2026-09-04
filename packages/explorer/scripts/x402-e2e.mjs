/**
 * End to end check of the x402 gateway, against a real chain.
 *
 * This is not a unit test and does not run in CI: it spends real testnet
 * PathUSD and waits on real blocks. Run it when the gateway changes.
 *
 *   # a coordinator with a payee configured and a committee registered
 *   PEAL_X402_PAYTO=0xYourAddress \
 *   BTE_PARAMS_FILE=.dev-ceremony/params.bin \
 *   BTE_LISTEN=127.0.0.1:8793 cargo run -p bte-coordinator
 *
 *   # then, from packages/explorer
 *   node scripts/x402-e2e.mjs
 *
 * It checks the whole handshake and the things that must NOT work: replaying a
 * payment, underpaying, presenting a hash that paid nobody, and whether the free
 * API is still free.
 */
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://rpc.moderato.tempo.xyz';
const API = 'http://127.0.0.1:8793';
const tempo = defineChain({ id: 42431, name: 'Tempo', nativeCurrency: { name: 'PathUSD', symbol: 'PathUSD', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain: tempo, transport: http(RPC) });
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

/** Keyless funding returns before the balance is there, so a transfer fired
 *  straight after it reverts. Wait for the money to actually arrive. */
async function waitFunded(asset, who, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const bal = await pub.readContract({ address: asset, abi: erc20, functionName: 'balanceOf', args: [who] });
    if (bal > 0n) return bal;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0n;
}
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

// 1. an unpaid call is refused, and the refusal says how to pay
const un = await fetch(`${API}/v1/x402/parameters`);
const req = await un.json();
ok('unpaid call answers 402', un.status === 402, `got ${un.status}`);
const accept = req?.accepts?.[0];
ok('402 carries payment requirements', !!accept?.payTo && !!accept?.asset);
console.log('     price', accept?.extra?.priceDisplay, 'to', accept?.payTo, 'asset', accept?.asset);
ok('scheme is named honestly', accept?.scheme === 'tempo-transfer', accept?.scheme);

// 2. a fresh browser-style wallet, funded with no account and no faucet form
const acct = privateKeyToAccount(generatePrivateKey());
const fund = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [acct.address] }) }).then(r => r.json());
const funded = await waitFunded(accept.asset, acct.address);
ok('keyless funding worked', funded > 0n, `${acct.address} balance ${funded}`);

// 3. pay exactly what was asked for
const wallet = createWalletClient({ account: acct, chain: tempo, transport: http(RPC) });
const hash = await wallet.writeContract({ address: accept.asset, abi: erc20, functionName: 'transfer',
  args: [accept.payTo, BigInt(accept.maxAmountRequired)] });
const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
ok('payment confirmed on chain', rc.status === 'success', hash);

// 4. retry with the proof
const pay = Buffer.from(JSON.stringify({ txHash: hash })).toString('base64');
const paid = await fetch(`${API}/v1/x402/parameters`, { headers: { 'x-payment': pay } });
ok('paid call is served', paid.status === 200, `got ${paid.status}`);
const rcpt = paid.headers.get('x-payment-response');
const decoded = rcpt ? JSON.parse(Buffer.from(rcpt, 'base64').toString()) : null;
ok('receipt header returned', !!decoded?.transaction, decoded?.explorer ?? '');
ok('receipt names the real tx', decoded?.transaction === hash);
const body = await paid.json();
ok('the resource itself came back', !!body?.committee_id || !!body?.digest, Object.keys(body).slice(0,4).join(','));

// the paid twin must be the SAME handler, not a lookalike
const freeBody = await fetch(`${API}/v1/parameters`).then((r) => r.json());
ok('paid twin returns the free handler byte for byte',
   JSON.stringify(freeBody) === JSON.stringify(body));

// 5. the same payment cannot buy a second call
const again = await fetch(`${API}/v1/x402/parameters`, { headers: { 'x-payment': pay } });
const againBody = await again.json();
ok('replay is refused', again.status === 402 && againBody.code === 'x402_already_redeemed', againBody.code ?? '');

// 6. a hash that paid nobody
const bogus = Buffer.from(JSON.stringify({ txHash: '0x' + '11'.repeat(32) })).toString('base64');
const bad = await fetch(`${API}/v1/x402/parameters`, { headers: { 'x-payment': bogus } });
ok('unknown hash is refused', bad.status === 402, `got ${bad.status}`);

// 6b. a paid POST does the real work: a round that actually exists
const acct2 = privateKeyToAccount(generatePrivateKey());
await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [acct2.address] }) });
await waitFunded(accept.asset, acct2.address);
const w2 = createWalletClient({ account: acct2, chain: tempo, transport: http(RPC) });
const h2 = await w2.writeContract({ address: accept.asset, abi: erc20, functionName: 'transfer',
  args: [accept.payTo, BigInt(accept.maxAmountRequired)] });
await pub.waitForTransactionReceipt({ hash: h2, timeout: 90_000 });
const made = await fetch(`${API}/v1/x402/rounds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json',
             'x-payment': Buffer.from(JSON.stringify({ txHash: h2 })).toString('base64') },
  body: JSON.stringify({ opens_in: 3600, tag: 'x402-demo' }),
});
const round = await made.json();
ok('a paid POST created a real round', made.status === 201 && !!round.id, `${made.status} ${round.id ?? round.detail ?? ''}`);
const readBack = await fetch(`${API}/v1/rounds/${round.id}`);
ok('that round is readable on the free API', readBack.status === 200);

// 7. the free API is untouched
const free = await fetch(`${API}/v1/parameters`);
ok('free API still free', free.status === 200, `got ${free.status}`);

// 8. an underpayment
const short = await wallet.writeContract({ address: accept.asset, abi: erc20, functionName: 'transfer',
  args: [accept.payTo, BigInt(accept.maxAmountRequired) / 2n] });
await pub.waitForTransactionReceipt({ hash: short, timeout: 90_000 });
const shortRes = await fetch(`${API}/v1/x402/parameters`, {
  headers: { 'x-payment': Buffer.from(JSON.stringify({ txHash: short })).toString('base64') } });
const shortBody = await shortRes.json();
ok('underpayment is refused', shortRes.status === 402 && shortBody.code === 'x402_payment_invalid', shortBody.detail ?? '');
console.log('\nexplorer:', `https://explore.testnet.tempo.xyz/tx/${hash}`);

# Charging per call with x402

Read this when the user wants to charge for something built on Peal, when they
mention x402, micropayments or pay per call, or when an agent has to pay for an
API without holding an account.

## What exists, stated plainly

**Peal's own API at `/v1` is free and stays free.** No key, no account, no
payment. If all you need is to seal and open things, use `reference/api.md` and
ignore this file.

Every `/v1` route is also mounted a second time under `/v1/x402`. Same handlers,
same request bodies, same responses. The only difference is that the metered
twin answers `402 Payment Required` until it is shown a payment.

So there are two honest reasons to read on:

1. **You are building something you want to charge for.** The pattern below is
   a working implementation you can copy into your own API. That is the main
   reason this file exists.
2. **You want an agent to pay rather than sign up.** Signing up needs an email,
   a card and a human. A 402 needs none of those.

Do not tell a user they have to pay to use Peal. They do not.

## The handshake

Four steps. There is nothing else to it.

1. Call the endpoint with no payment. You get a 402 naming the price, the asset,
   the payee and the chain.
2. Send that transfer on chain.
3. Call again with `X-PAYMENT: base64(json({"txHash":"0x..."}))`.
4. You get the ordinary response, plus an `X-PAYMENT-RESPONSE` header carrying
   the transaction hash and an explorer link.

## What a 402 looks like

```json
{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [{
    "scheme": "tempo-transfer",
    "network": "tempo-moderato",
    "maxAmountRequired": "1000",
    "asset": "0x20c0000000000000000000000000000000000000",
    "payTo": "0xf8b8ef05b9f820addf7d85d165433e6c60221af5",
    "resource": "https://peal.network/v1/x402/rounds",
    "maxTimeoutSeconds": 1800,
    "extra": {
      "symbol": "PathUSD",
      "decimals": 6,
      "priceDisplay": "0.001 PathUSD",
      "chainId": 42431,
      "rpc": "https://rpc.moderato.tempo.xyz",
      "explorer": "https://explore.testnet.tempo.xyz",
      "fundingRpcMethod": "tempo_fundAddress",
      "how": "..."
    }
  }]
}
```

Read the price from `accepts[0]` at runtime. Do not hard-code `1000`: the price,
the payee and the chain are all deployment settings and all of them can change.

`GET /v0/x402` returns the same requirements without having to trigger a 402,
so you can show a price before a user commits to anything. That endpoint is
free.

## A complete client

```js
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

async function paidFetch(url, init, account) {
  // 1. ask
  const first = await fetch(url, init);
  if (first.status !== 402) return first;   // free today, or a real failure

  const { accepts: [req] } = await first.json();

  const chain = defineChain({
    id: req.extra.chainId,
    name: req.network,
    nativeCurrency: { name: req.extra.symbol, symbol: req.extra.symbol, decimals: 18 },
    rpcUrls: { default: { http: [req.extra.rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(req.extra.rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(req.extra.rpc) });

  // 2. pay
  const hash = await wallet.writeContract({
    address: req.asset,
    abi: ERC20,
    functionName: 'transfer',
    args: [req.payTo, BigInt(req.maxAmountRequired)],
  });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rc.status !== 'success') throw new Error('the payment reverted, nothing was charged');

  // 3. ask again, carrying the proof
  const headers = new Headers(init.headers);
  headers.set('x-payment', btoa(JSON.stringify({ txHash: hash })));
  return fetch(url, { ...init, headers });
}

const res = await paidFetch('https://peal.network/v1/x402/rounds', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ opens_in: 3600, tag: 'my-agent' }),
}, account);

const round = await res.json();

// 4. the receipt
const receipt = JSON.parse(atob(res.headers.get('x-payment-response')));
console.log(round.id, receipt.transaction, receipt.explorer);
```

## Paying with no wallet at all

Tempo funds any address on request, with no faucet form and no account:

```js
await fetch(req.extra.rpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'tempo_fundAddress',       // req.extra.fundingRpcMethod
    params: [account.address],
  }),
});
```

That is enough to mint a keypair in a browser tab, fund it, pay, and never ask
the user for anything. Two things will bite you:

**Funding returns before the money arrives.** A transfer fired straight after
the call reverts. Poll `balanceOf` until it is above zero:

```js
while ((await pub.readContract({
  address: req.asset, abi: ERC20, functionName: 'balanceOf', args: [account.address],
})) === 0n) {
  await new Promise((r) => setTimeout(r, 1000));
}
```

**`eth_getBalance` is meaningless on Tempo.** There is no native token: gas is
itself an ERC-20 at `0x20c0...0000`, which is also what payments are made in.
`eth_getBalance` returns a fixed sentinel around `4.2e57` for every address and
never changes. Always read `balanceOf` on the asset. A wallet UI showing an
absurd balance is showing you that sentinel, not your money.

## What the server checks before a paid call runs

1. The hash has never been redeemed here before.
2. The receipt exists and the transaction succeeded.
3. It carries an ERC-20 Transfer of at least the price, in the right asset, to
   the right payee. Several transfers to the payee in one transaction are added
   together.
4. The block is recent, within `maxTimeoutSeconds`, so an old transfer to the
   same payee cannot be presented as new payment.

Redemption is a database insert keyed on the transaction hash, so one payment
buys exactly one call even if two requests race.

## Errors

All RFC 9457 problem+json with a stable `code`.

| code | status | what happened |
| --- | --- | --- |
| `x402_bad_payment` | 400 | `X-PAYMENT` is not base64 and not a transaction hash |
| `x402_payment_invalid` | 402 | no receipt yet, the transaction failed, it underpaid, or it is too old |
| `x402_already_redeemed` | 402 | that payment has already bought a call |
| `x402_not_configured` | 503 | this deployment has no valid payee, metered calls are off |

`x402_payment_invalid` with "no receipt for that transaction yet" means you
retried before the transaction was mined. Wait for the receipt, then retry. Do
not pay twice.

## This is not the `exact` scheme

The x402 `exact` scheme on EVM has the payer sign an EIP-3009 authorisation
which a facilitator broadcasts. That needs a funded key on the server, and this
coordinator holds none. So the scheme is named `tempo-transfer`: the payer
broadcasts and the server verifies against the chain.

Same handshake, same settlement, reached from the other side. If you are writing
a generic x402 client, branch on `scheme` and do not assume `exact`.

## Building the same thing into your own API

This is the part most users of this skill actually want. The shape is:

1. Refuse with 402 and a body naming price, asset, payee and chain.
2. On retry, read the transaction hash out of `X-PAYMENT`.
3. Fetch the receipt over JSON-RPC. Check status, the Transfer log, the amount,
   the payee, and the block age.
4. Record the hash in a table with the hash as the primary key. The insert is
   the redemption, which is what stops the same payment buying twice.
5. Only then run the handler, and return the receipt in `X-PAYMENT-RESPONSE`.

Two things to get right, because they are the ones that cost money:

- **Redeem before you serve, not after.** If you serve first and record second,
  a crash in between gives away work for free, and concurrent requests with the
  same hash both succeed.
- **Verify the payee and the asset, not just the amount.** A transaction that
  moved the right number of some other token, or the right token to somebody
  else, is not payment. Check the log's contract address and the recipient
  topic.

A working implementation is `crates/bte-coordinator/src/x402.rs` in the Peal
repository, and the page at `https://peal.network/#/developers/x402` runs the
whole handshake live in the browser.

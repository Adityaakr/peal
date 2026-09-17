# Peal Private Links

Read this when the user wants to get paid privately, send money privately,
add a "pay me" link, or mentions Peal Links, Peal Private Links, Bonsai, a
private balance, or a payment whose amount should not be on a chain. It is a
different engine from sealed submissions: nothing here opens at a deadline.

## What exists, stated plainly

**A private payment ledger with a product on top.** A receiver creates a
request (an amount in one asset, a title, an optional reference and expiry) and
shares a link. The payer opens it, connects a wallet, and pays. Deposits and
withdrawals are public transactions through a gateway contract on the chain;
every payment in between is a zero-knowledge proof on a ledger built for
payments. The ledger learns which account acted. It does not learn the amount,
the other party, or whether it was a send or a receive.

**Today, hosted: Ethereum Sepolia only.** Circle's testnet USDC and a faucet
token, behind one hosted node at `https://peal.network/links/v1`. Tempo
Moderato is also deployed and tested but must be run from the repository. Test
funds. Do not
tell a user it takes real money: the node refuses to run its settlement signers
or the dev-mint fixture beside a mainnet namespace, so no mainnet withdrawal is
possible today.

**What the user needs:** an EVM wallet. That is the whole identity. At setup
the wallet signs a sign-in message, a recovery message (twice, if it signs
deterministically) and the profile authorization; then a sign-in every twelve
hours and one approval per payment. Deposits and withdrawals are ordinary
transactions. Nothing that can spend leaves the client.

Live pages: `https://peal.network/developers/links` (the picture),
`https://peal.network/developers/links-sdk` (every SDK method),
`https://peal.network/developers/links-api` (every route). The product is at
`https://peal.network/#/bonsai/app`, a checkout is `https://peal.network/pay/<id>`.

## The two ways in

1. **The SDK, `peal-links`.** TypeScript, ships as source with the wasm prover
   inlined, runs in a page, a Web Worker or Node. Not on npm yet: use it from
   the repository as a path or workspace dependency, and add `viem`.
   ```bash
   # from the project's directory
   git clone https://github.com/Adityaakr/peal-network ../peal-network
   pnpm add ../peal-network/packages/links viem
   ```
   Use this for anything that holds an account: proofs, envelopes, backups and
   the wallet signatures are all handled.
2. **The HTTP API, `/links/v1`.** JSON in, JSON out, errors as
   `application/problem+json`. Use it from any language for the public reads
   (status, ledger, a request by id) and for building your own client. Anything
   that moves value carries a proof, so a non-JavaScript integrator either
   embeds the wasm prover or drives the SDK from a small Node process.

## The flow, in the order the calls happen

1. **Bootstrap.** `GET /links/v1/status` names the namespaces (an asset on a
   chain: id, chain, token, decimals, gateway, confirmations), the circuit id
   and the settlement signers. `GET /links/v1/params` serves the proving keys by
   digest. The SDK does both in `client.status()` and `loadParams()`.
2. **Sign in.** `GET /auth/nonce`, then the wallet signs an EIP-4361 message and
   `POST /auth/session` returns a bearer token, 12 hours. Sessions authorize
   metadata only: requests, the profile, backups. The `domain` line must be one
   the node accepts; the hosted node accepts `peal.network`. An app on its own
   origin runs its own node with `PEAL_LINKS_AUTH_DOMAINS`.
3. **Set up the account, once.** `LinksAccount.setup(opts, circuitId, signer,
   displayName, recovery)`: registers on the ledger, has the wallet sign the
   EIP-712 `PealLinksAccount` profile, publishes it to the directory, seals the
   wallet under a device key, uploads the first backup. Same device later:
   `LinksAccount.unlock(opts)`. New device: `LinksAccount.recover(opts, recovery)`.
4. **Request.** `account.createRequest({ amount, title, reference?, expiresAt? })`
   returns a manifest signed by the private account. The link is
   `https://peal.network/pay/` + `request.manifest.request_id`. No wallet popup.
5. **Fund, if the payer's private balance is short.** `prepareDeposit(amount)`
   proves the deposit relation and registers the intent; then the wallet calls
   `gateway.deposit(token, amount, tag)` (`depositOnChain` does approve and
   deposit); then `syncDeposits()` until the watcher credits it, two
   confirmations later; then `claimAll()`.
6. **Pay.** `client.getRequest(id)`, `account.paymentIntentFor({ request })`,
   the wallet signs `paymentIntentTypedData(intent, chainId)`, then
   `account.pay({ request }, newIntentId(), { intent, signature })`. The SDK
   verifies the request's signature and the receiver's profile itself, reserves
   the request for ten minutes, proves, submits, and delivers an encrypted
   receipt. A direct send is `resolve(address)` then
   `pay({ profile, profileHash, amount, reference? }, ...)`.
7. **Claim.** The receiver, whenever next online: `sync()` then `claimAll()`.
   `acknowledge(requestId, position)` marks the link fulfilled.
8. **Withdraw.** `withdraw(amount, recipient)` proves a burn and returns a
   certificate from the settlement signers; `withdrawOnChain(ns, provider, from,
   certificate)` submits it. Anyone may submit; the recipient is inside the
   signed message.

## A complete example

```js
import { LinksAccount, NodeClient, loadParams, newIntentId, paymentIntentTypedData,
         localSigner, deriveBackupKey, deterministicSignature, recoveryMessage,
         newRecoveryCode, siweMessage, MemoryStore } from 'peal-links';
import { createLocalProver } from 'peal-links/local';
import { privateKeyToAccount } from 'viem/accounts';

// 1. node, namespace, prover
const client = new NodeClient({ baseUrl: 'https://peal.network' });
const status = await client.status();
const ns = status.namespaces.find((n) => n.label === 'sepolia/USDC');
const prover = await createLocalProver();
const store = new MemoryStore();                 // implement WalletStore for anything real
await loadParams(client, prover, store);

// 2. one wallet is the identity; a session first (the profile and requests need one)
const signer = localSigner(privateKeyToAccount(process.env.KEY), ns.chain_id);
const { nonce } = await client.nonce();
const message = siweMessage({ domain: 'peal.network', address: signer.address,
                              uri: 'https://peal.network', chainId: ns.chain_id, nonce });
await client.session(message, await signer.signMessage(message));

// recovery: a deterministic wallet signature when the wallet gives one, else a code shown once
const sig = await deterministicSignature(signer, recoveryMessage(signer.address, ns.label, ns.id));
const recovery = sig
  ? { mechanism: 'wallet-signature', backupKey: await deriveBackupKey(sig, signer.address, ns.id) }
  : { mechanism: 'recovery-code', code: newRecoveryCode() };
const me = await LinksAccount.setup({ prover, client, namespace: ns.id, store }, status.circuit_id, signer, 'Shop', recovery);

// 3. a request to share
const request = await me.createRequest({ amount: '12500000', title: 'Logo files', reference: 'INV-7' });
console.log('https://peal.network/pay/' + request.manifest.request_id);

// 4. later: collect what arrived
const { discovered } = await me.sync();
await me.claimAll();
console.log((await me.view()).balance, 'base units');
```

## The procedure

Same discipline as a sealed-submission integration. Say what you found before
you build.

1. **Survey.** Who receives and who pays? A shop receiving from customers is
   one receiving account the server can own; a peer-to-peer feature is one
   account per user, held in their browser. Where does the app run: a server,
   a static page, both? Is there already a wallet connection (wagmi, viem, an
   EIP-1193 provider)? Which chain are they on: Sepolia is the only hosted one.
2. **Choose where the account lives.**

   | account owner | where the SDK runs | store | signer |
   | --- | --- | --- | --- |
   | the business (a shop, a treasury) | a Node process the business runs | your own `WalletStore` over a database, plus `DeviceKeys` | `localSigner` with a key the business holds |
   | each user | the user's browser | `indexedDbStore()` | `providerSigner` over their wallet |

   A user's account in a server is the user's money in your custody. Do not
   build that quietly.
3. **Choose the checkout.** The hosted page at `https://peal.network/pay/<id>`
   is complete: request verification, wallet connect, funding, approval,
   proof, delivery. Link to it. Build your own only if the product needs it,
   and then read "Sessions on your own origin" below.
4. **Implement** from the example above, or the recipe in
   `reference/recipes.md` ("Getting paid privately").
5. **Verify** with the script below before reporting success.

## Sessions on your own origin

The hosted node signs in wallets for the domain `peal.network`. A script with
its own key (a shop's server) may sign in with that domain, because nobody is
being asked to trust a page. A browser wallet on `shop.example` must not be
asked to sign a message that says `peal.network wants you to sign in`; that is
the shape of a phishing prompt. For a browser integration on another origin,
run a node (`docs/peal-links/OPERATIONS.md` in the repository) with
`PEAL_LINKS_AUTH_DOMAINS=shop.example`, point `NodeClient` at it, and the same
Sepolia gateway serves both.

## Verify before you say it is done

A script that proves the integration against the hosted node: reads the node,
signs in, sets up an account, creates a request, reads it back the way a payer
would, and verifies the manifest and profile. It needs no funds. About twenty
seconds, most of it downloading the proving key on the first run.

```js
// verify-links.mjs: node verify-links.mjs   (KEY=0x… a throwaway Sepolia key, no funds needed)
import { LinksAccount, NodeClient, loadParams, localSigner, siweMessage,
         deterministicSignature, recoveryMessage, deriveBackupKey, newRecoveryCode,
         MemoryStore } from 'peal-links';
import { createLocalProver } from 'peal-links/local';
import { privateKeyToAccount } from 'viem/accounts';

const client = new NodeClient({ baseUrl: 'https://peal.network' });
const status = await client.status();
const ns = status.namespaces.find((n) => n.label === 'sepolia/USDC');
if (!ns?.available) throw new Error('sepolia/USDC is not available on this node');
console.log('node ok, circuit', status.circuit_id.slice(0, 12), 'signers', status.signers.length, 'threshold', status.signer_threshold);

const store = new MemoryStore();
const prover = await createLocalProver();
await loadParams(client, prover, store);
console.log('proving keys verified by digest');

const signer = localSigner(privateKeyToAccount(process.env.KEY), ns.chain_id);
const { nonce } = await client.nonce();
const message = siweMessage({ domain: 'peal.network', address: signer.address, uri: 'https://peal.network', chainId: ns.chain_id, nonce });
await client.session(message, await signer.signMessage(message));
console.log('session for', (await client.me()).address);

const sig = await deterministicSignature(signer, recoveryMessage(signer.address, ns.label, ns.id));
const recovery = sig
  ? { mechanism: 'wallet-signature', backupKey: await deriveBackupKey(sig, signer.address, ns.id) }
  : { mechanism: 'recovery-code', code: newRecoveryCode() };
const me = await LinksAccount.setup({ prover, client, namespace: ns.id, store }, status.circuit_id, signer, 'Verify', recovery);
console.log('account registered; balance', (await me.view()).balance);

const request = await me.createRequest({ amount: '1000000', title: 'verify', reference: 'verify-1' });
const id = request.manifest.request_id;
const seen = await client.getRequest(id);
if (seen.status !== 'active' || seen.manifest.amount !== '1000000') throw new Error('request did not round-trip');
const resolved = await me.resolve(signer.address);
if (!resolved || resolved.profile.profile_key !== seen.manifest.signer_pubkey) throw new Error('profile does not match the manifest');
console.log('request', id, 'verifies; pay page https://peal.network/pay/' + id);
await client.archiveRequest(id);
console.log('PASS');
```

What a pass looks like: six lines ending in `PASS`. What each failure means:

- `sepolia/USDC is not available`: the node's chain watcher cannot reach the
  RPC; nothing you did. Try later.
- `unauthorized` at `session`: the domain, nonce or issued-at was rejected;
  the clock on the machine is more than two minutes off, or the message was
  edited.
- `invalid_proof` or `wrong_circuit` at `setup`: the keys in the store are for
  another circuit id; clear the store and let `loadParams` fetch again.
- `unregistered_receiver` at `createRequest`: `setup` did not finish
  registering; run again.
- `profile does not match`: the directory answered with a profile whose key
  is not the one that signed the manifest. Stop; do not pay such a request.

To verify a payment end to end with funds, run the SDK's own suite against the
local stack in the repository: `scripts/peal-links/stack.sh up` then
`pnpm -C packages/links test`. It deposits, pays, claims and withdraws on two
local chains.

## Building the interface

Match their design system (`reference/ui.md`) and build these states; the
hosted checkout at `/pay/<id>` shows each of them if you want to see one.

| state | what to show | what not to show |
| --- | --- | --- |
| verifying the request | the title and amount only after the manifest and profile verify | anything from the node before verification |
| connect wallet | one button; the wallet is the whole identity | a sign-up form |
| first visit | "this wallet has no private account here yet; setting one up asks for one signature" | jargon about commitments |
| funding | the public deposit, its transaction hash, "credited after 2 confirmations" | a spinner with no hash |
| approve | the wallet prompt with the amount and the recipient's name; say it is a local approval, not a transaction | a gas estimate (there is none) |
| proving | "proving, about seven seconds"; keep the tab open | a fake progress bar |
| delivering | "receipt delivered" or "receipt queued, will retry" (the inbox may be briefly unreachable; the payment already happened) | treating an undelivered receipt as a failed payment |
| done | the position on the ledger, and that nothing about the amount is public | a chain explorer link for the payment (there is no chain transaction) |
| errors | the `code` mapped to a sentence: `reserved` (someone else is paying this right now), `not_payable` (expired or already paid), `stale_commitment` (refresh and retry), `unreachable` (the node is down; nothing was spent) | the raw problem+json |

Amounts are formatted from base units with the namespace's decimals, never
parsed from a float the user typed: read the input as a string, split on the
decimal point, and build the integer.

## Money and encodings

- Amounts are decimal strings of integer base units on every boundary:
  `'12500000'` is 12.50 USDC. Decimals come from the namespace. Compare with
  `BigInt`. Never a float, never a number with a decimal point.
- Namespace ids, account ids, keys and tags are 32 bytes as 64 lowercase hex
  characters without `0x`. Addresses are lowercase `0x`. Timestamps are Unix
  seconds. Proofs are 128 bytes.
- One exception on the API: `amount` in `POST /deposits/intents` is a JSON
  number, because the wasm prover emits that envelope. Everything else is a
  string.

## What the server checks, and what it cannot

The node verifies sign-ins, profile signatures, request manifests, key
bindings, inbox read headers, withdrawal claims, and every zero-knowledge proof.
It cannot forge an account signature or a wallet signature, and cannot forge a
proof under the proof system's soundness assumption, so it cannot spend or forge
a receipt, and cannot release a withdrawal without the signer threshold. That
soundness assumption is itself unaudited today: per-process key setup, no
external review of the circuits.

The **client** must verify two things itself and never take the node's word:
the request manifest's signature against the receiver's account, and the
receiver's directory profile against the wallet address in it, including the
version chain. The SDK does both in `pay` and `resolve`.

## Errors

Every error body is `{ type, title, status, code, detail }`. Match on `code`.

| code | status | what happened |
|---|---|---|
| `unauthorized` | 401 | no session, an expired one, a bad account signature, a stale inbox header |
| `stale_commitment` | 409 | the account moved since the proof was made; refresh and prove again |
| `root_not_recent` | 409 | the proof's root is older than the last 1024; refresh the path |
| `invalid_proof` | 422 | the proof did not verify; the circuit id or the keys do not match |
| `reserved` / `not_payable` | 409 | another payer holds the request; or it is expired, fulfilled or archived |
| `request_exists` | 409 | a different manifest under an id already used |
| `profile_rejected` / `backup_rejected` | 409 | version or `seq` did not increase |
| `already_attested` | 409 | a second, different withdrawal claim for the same burn |
| `not_enough_signers` / `chain_unreachable` | 503 | settlement cannot certify right now; retry. Through the SDK every 502, 503 and 504 arrives as status 0, code `unreachable` |
| `rate_limited` | 429 | more than 60 directory lookups in a minute on one session |

The SDK raises `LinksApiError` with the same `status` and `code` for 4xx and
500; a network failure, a non-JSON body, or a 502, 503 or 504 is status 0, code
`unreachable`.

## The trust model, stated plainly

Say these to the user; do not soften them.

- **Testnet only.** Sepolia, test tokens, one hosted node run by the operator.
- **Private, not unlinkable.** The node's directory knows which wallet owns
  which private account. The ledger shows which account acted and when.
  Deposits and withdrawals are public on the chain, and an observer can
  correlate them by amount and timing. Between them, the amount and the
  parties of a payment are on no chain.
- **Withdrawals are committee-attested, not trustless.** Two of three settlement
  signers certify a burn; today their keys live in one process. A compromised
  threshold can release reserves. If the operator disappears, funds not yet
  withdrawn are stuck. Never call the bridge trustless, ZK-settled or
  rollup-secured.
- **No ceremony, no audit.** The proving keys come from a per-process setup;
  the circuits are a pinned prototype revision with no external review.
- **Recovery is the user's.** The recovery signature or code never reaches the
  node. Losing the device and the recovery material loses the account.
- **The node can delay or refuse.** It cannot spend, read a balance, or read a
  receipt.

Source of truth: `crates/peal-links-node/src/api.rs` for the routes,
`packages/links/src/account.ts` for the SDK, `docs/peal-links/THREAT_MODEL.md`
for who sees what, `docs/peal-links/MAINNET_READINESS.md` for what changes before
real money.

# @soroban-keeper-network/sdk

A typed TypeScript client for the keeper-registry contract in
[`contracts/keeper-registry`](../../contracts/keeper-registry).

It replaces the hand-built `simulate -> build -> sign -> submit -> confirm`
sequence that `examples/keeper-bot` currently open-codes with one client class
and one typed method per contract entry point.

```ts
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { KeeperRegistryClient, keypairSigner } from "@soroban-keeper-network/sdk";

const client = new KeeperRegistryClient({
  contractId: process.env.REGISTRY_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: keypairSigner(Keypair.fromSecret(process.env.SECRET_KEY!)),
});
```

Read-only methods need no signer and no funded account: they are simulated,
never submitted. State-changing methods need a signer whose public key matches
the address the contract requires authorization from, and the SDK checks that
locally rather than spending a fee on a transaction that would fail
`require_auth`.

## `client.extendDeadline`

```ts
await client.extendDeadline({
  owner,
  taskId: 42n,
  newDeadline: new Date("2026-01-01T00:00:00Z"),
});
```

## Conventions

**Large integers are `bigint`.** The contract's `i128` rewards and balances can
exceed `Number.MAX_SAFE_INTEGER`, and `scValToNative`/`nativeToScVal` already
produce and accept `bigint` for `i128` and `u64`, so the SDK adds no conversion
layer of its own. `u32` fields (`feeBps`, `version`, ledger counts) stay plain
`number`. A `number` is accepted where an integer is expected, but a
non-integer or unsafe one is rejected rather than silently rounded.

**Timestamps accept `Date | number | bigint` and are returned as `Date`.** A
bare number or bigint is read as Unix *seconds*, matching the
`Math.floor(Date.now() / 1000)` the keeper-bot already computes. A value that
looks like milliseconds is rejected at the boundary rather than accepted as a
deadline in the year 54,000.

## Errors

Every failure is typed, so nothing needs to match on an error message:

- `KeeperContractError` -- the contract returned `Result::Err`. Its `code` is a
  `KeeperErrorCode`, mirroring `contracts/keeper-registry/src/errors.rs`
  discriminant for discriminant. `error.local` is `true` when the SDK applied
  the same rule locally and never built a transaction.
- `KeeperRpcError` -- the call never reached a contract verdict: transport
  failure, malformed response, or a host-level trap.
- Both extend `KeeperSdkError`.

```ts
import { KeeperErrorCode, isKeeperError } from "@soroban-keeper-network/sdk";

try {
  await client.extendDeadline({ owner, taskId, newDeadline });
} catch (error) {
  if (isKeeperError(error, KeeperErrorCode.NotTaskOwner)) return;
  throw error;
}
```

## Development

```sh
npm install
npm test        # vitest, no network required
npm run typecheck
npm run build   # ESM + CJS + .d.ts into dist/
```

The client takes its RPC server as an injected dependency (the `server`
option), which is how the test suite exercises every path without a live
network. Argument encoding and result decoding are not faked: tests assert on
values that have been through the real `nativeToScVal`/`scValToNative`.

## Package layout

| Path | Contents |
| --- | --- |
| `src/client.ts` | `KeeperRegistryClient`: the shared read and write paths |
| `src/core/` | the caller seam and the shared conversion helpers |
| `src/methods/` | one module per contract entry point |
| `src/errors.ts` | `KeeperErrorCode` and the contract-error decoder |

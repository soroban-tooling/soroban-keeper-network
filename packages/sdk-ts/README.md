# @soroban-keeper-network/sdk

Typed TypeScript client for the Soroban Keeper Network `keeper-registry`
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

## Contract-level views

```ts
await client.admin(); // string | undefined -- undefined if never initialized
await client.getFeeBps(); // number
await client.isPaused(); // boolean
await client.feesAccrued(); // bigint
await client.rewardTokenAddress(); // string | undefined
await client.minReward(); // bigint
await client.version(); // number, with a compatibility check
## `client.withdrawRewards`

```ts
const withdrawn: bigint = await client.withdrawRewards({ keeper });

// Or, treating an empty balance as a normal "nothing to do":
const maybe: bigint = await client.tryWithdrawRewards({ keeper });
## `client.extendDeadline`

```ts
await client.extendDeadline({
  owner,
  taskId: 42n,
  newDeadline: new Date("2026-01-01T00:00:00Z"),
});
## `client.executeTask`

```ts
await client.executeTask({ keeper, taskId: 42n, proof: txHashHex });
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
**Proofs accept `Uint8Array | Buffer | string`, and a string is always hex.**
The `0x` prefix is optional. A string that is not valid hex is refused instead
of falling back to UTF-8, because guessing wrong between the two encodings puts
different bytes on-chain than the caller intended. To submit text, encode it
yourself: `new TextEncoder().encode(text)`.

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
  await client.version();
} catch (error) {
  if (isKeeperError(error, KeeperErrorCode.NotInitialized)) return;
  await client.withdrawRewards({ keeper });
} catch (error) {
  if (isKeeperError(error, KeeperErrorCode.NoRewardsAvailable)) return;
  await client.extendDeadline({ owner, taskId, newDeadline });
} catch (error) {
  if (isKeeperError(error, KeeperErrorCode.NotTaskOwner)) return;
  await client.executeTask({ keeper, taskId, proof });
} catch (error) {
  if (isKeeperError(error, KeeperErrorCode.NotTaskClaimer)) return;
  throw error;
}
```

## Contract compatibility

`SUPPORTED_CONTRACT_VERSIONS` records the contract `VERSION` range this SDK
release was built against. `client.version()` reads the deployed contract's
version and warns -- once per client, through the `warn` option -- when it
falls outside that range; `client.checkContractCompatibility()` returns the
same comparison without emitting anything, for callers that want to decide for
themselves. A mismatch warns rather than throwing: contract versions are
additive, and a client library that refuses to run against a newer contract
strands every integrator on the day it is upgraded.

Keeping that range accurate on a contract version bump is the SDK versioning
## Contract constants

The SDK's copy of the contract's `MAX_PROOF_LEN` exists only to turn a doomed
call into a local error instead of a wasted round trip. The deployed contract
always remains authoritative, so a drifted copy can never make an invalid call
succeed. Keeping it in sync on a contract version bump is the SDK versioning
policy's job (backlog issue 0192).

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
| `src/constants.ts` | the supported contract `VERSION` range |
| `src/constants.ts` | the SDK's copy of the contract's bounds |
Typed TypeScript client for the Soroban Keeper Network `keeper-registry`
contract (epic E12). This package includes the shared client plumbing
(`KeeperRegistryClient`), typed error decoding, the `getTask` view method,
transaction-building primitives for wallet-signing and fee-bump flows, and
two React hooks — built to unblock issues #241, #243, #248, and #259. It is
not the full epic: `taskCount`/`keeperBalance`/`isClaimable` (backlog 0163's
remaining scope), the write methods (`registerTask`, `claimTask`, ...), and
most of the admin surface are other contributors' open PRs (see
[soroban-tooling/soroban-keeper-network#310, #318, #319, #320, #322–332,
#535](https://github.com/soroban-tooling/soroban-keeper-network/pulls?q=is%3Apr+sdk-ts)
at the time this was written) or later issues in the same epic, not
duplicated here.
contract. This package is currently a **scaffold** (backlog 0151 / epic
E12): it ships build tooling, a `tsconfig.json`, and a placeholder export
so the ESM/CJS/`.d.ts` pipeline is proven end to end. The
`KeeperRegistryClient` and its per-entry-point methods land in the rest of
epic E12's issues.

## Workspace tooling decision

This package is a **standalone npm package**, not an npm/pnpm workspace
member — there is no root `package.json` in this repository. This matches
the existing convention for `examples/keeper-bot` and
`examples/batch-register`.
`examples/batch-register`, which are each installed and built independently
with their own `node_modules`. Adopting workspaces would be a repo-wide
change affecting those packages too, which is out of scope for this
scaffold; it can be revisited later if the growing number of `packages/`
and `examples/` entries makes standalone installs unwieldy.

## Quick start

```bash
cd packages/sdk-ts
npm install
npm run build   # emits dist/cjs (CommonJS), dist/esm (ESM), and .d.ts declarations
npm test        # builds, then runs the require()/import smoke tests
```

npm test        # builds, then runs the smoke tests and the vitest suite
```

```ts
import { KeeperRegistryClient } from "@soroban-keeper-network/sdk";

const client = new KeeperRegistryClient({
  contractId: "C...",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  // Needed by getTask (and the useTask/useTaskEvents hooks) — Soroban
  // simulation requires a funded source account even for a read-only call.
  // Any funded account works; it is never signed with or spent from.
  readOnlySourceAccount: "G...",
});

const task = await client.getTask(42); // throws TaskNotFoundError if it doesn't exist
```

### React hooks

```tsx
import { KeeperRegistryProvider, useTask, useTaskEvents } from "@soroban-keeper-network/sdk/react";

function App() {
  return (
    <KeeperRegistryProvider client={client}>
      <TaskDetail taskId={42} />
    </KeeperRegistryProvider>
  );
}

function TaskDetail({ taskId }: { taskId: number }) {
  const { task, loading, error } = useTask(taskId, { pollIntervalMs: 5000 });
  const { events } = useTaskEvents({ eventTypes: ["TaskClaimed", "TaskExecuted"] });
  // ...
}
```

React is a **peer dependency**, not a direct one — importing from the
package's main entry point (`@soroban-keeper-network/sdk`) never pulls in
React.

### Wallet-signing (no secret key ever touches this SDK)

See [`examples/wallet-signing/registerTaskWithFreighter.ts`](examples/wallet-signing/registerTaskWithFreighter.ts)
for the full worked example, including the user-rejects-the-signature case.
**Read that file's "Verification status" section before relying on it** —
it has not yet been run against the real Freighter browser extension in
this environment.

```ts
const unsigned = await client.buildTransaction(userAddress, "register_task", args);
// hand unsigned.xdr to a wallet's signTransaction(...)
await client.submitSignedTransaction(signedXdr);
```

### Sponsored fees (fee-bump)

```ts
// User signs their own inner transaction (which pays no fee itself)...
const unsigned = await client.buildTransaction(userAddress, "register_task", args);
const userSignedXdr = await userWallet.sign(unsigned.xdr);

// ...then a sponsor wraps and pays the fee-bump envelope.
const feeBumpUnsigned = client.buildFeeBumpTransaction(sponsorAddress, userSignedXdr);
const sponsorSignedXdr = await sponsorSigner.sign(feeBumpUnsigned.xdr);
await client.submitSignedTransaction(sponsorSignedXdr);
```

## Layout

- `src/index.ts` — package entry point (`KeeperRegistryClient`, errors, transaction-building primitives, types).
- `src/react/index.ts` — separate `@soroban-keeper-network/sdk/react` entry point (`KeeperRegistryProvider`, `useTask`, `useTaskEvents`).
- `src/core/contractInvoker.ts` — shared simulate/build/sign/submit plumbing.
- `src/events.ts` — typed decoders for the contract's task-lifecycle events.
- `src/errors.ts` — typed `KeeperErrorCode` decoding.
- `src/transactionBuilder.ts` — unsigned-XDR and fee-bump building for wallet-signing flows.
- `CONVENTIONS.md` — the numeric/timestamp/field-naming conventions every method in this epic follows.
- `examples/wallet-signing/` — the Freighter worked example (issue #259).
- `tsconfig.json` / `tsconfig.cjs.json` / `tsconfig.esm.json` — build configuration.
- `scripts/fix-esm-extensions.mjs` — post-build step appending `.js` to relative ESM import specifiers (see the script's own comment for why this is needed).
- `test/` — `node --test` smoke tests (`require()`/`import` against the built `dist/` output). Unit tests live alongside their source as `*.test.ts` and run via `vitest`.
npm test        # builds, then runs the require()/import smoke tests
```

## API reference

Generated from this package's TSDoc comments via
[TypeDoc](https://typedoc.org/) (config: `typedoc.json`), so every exported
method, hook, and type contributes to the reference automatically by having
a good doc comment — no separate documentation PR needed per method.

```bash
npm run docs        # generates HTML into docs/reference/ (gitignored — a build artifact, not source)
npm run docs:check  # generates with warnings treated as errors; fails if any exported symbol is undocumented
```

`docs:check` is wired into CI (`.github/workflows/ci.yml`'s `sdk-ts-docs`
job) as an **advisory** check — it reports doc-comment regressions in the
job summary but never blocks a PR, consistent with this repo's advisory-vs-required
CI policy (see `docs/CI.md`).

**Output and publishing:** HTML, generated on demand and gitignored — not
committed to this repo, and not yet published anywhere (e.g. GitHub Pages).
Publishing the generated output is explicitly out of scope for now; this
can be revisited once the SDK's surface is large enough to be worth
browsing outside of a local `npm run docs`.

## Layout

- `src/index.ts` — package entry point.
- `tsconfig.json` — shared compiler options.
- `tsconfig.cjs.json` / `tsconfig.esm.json` — per-target build configs.
- `test/` — `node --test` smoke tests, one exercising `require()` and one
  exercising `import`, against the built `dist/` output.
- `typedoc.json` — TypeDoc config for the generated API reference.
- `test/` — `node --test` smoke tests, one exercising `require()` and one
  exercising `import`, against the built `dist/` output.
TypeScript client for the Soroban Keeper Network's `KeeperRegistry`
contract.

## Install

Not yet published to npm. For now, reference it as a local path dependency
(see `examples/keeper-bot/package.json` for the pattern):

```json
{
  "dependencies": {
    "@soroban-keeper-network/sdk": "file:../../packages/sdk-ts"
  }
}
```

## Usage

```ts
import { KeeperRegistryClient, withRetry } from "@soroban-keeper-network/sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new KeeperRegistryClient({
  contractId: "C...",
  network: "testnet",
  keypair: Keypair.fromSecret(process.env.KEEPER_SECRET_KEY!),
});

// State-mutating call: simulates, signs, submits, polls for confirmation.
await withRetry(
  () => client.invoke("claim_task", [/* ...ScVal args */]),
  { maxRetries: 3, retryBaseMs: 500 },
);

// Read-only view: simulation only, no signed transaction.
const balance = await client.read("keeper_balance", [/* ...ScVal args */]);
```

See [VERSIONING.md](./VERSIONING.md) for how this package's releases relate
to the contract's `VERSION`, and [CHANGELOG.md](./CHANGELOG.md) for release
notes.

## Network presets

`network: "testnet"` (recommended default — used throughout this README
and `examples/keeper-bot`) resolves internally to a verified `NetworkPreset`
(`rpcUrl` + `networkPassphrase`) via `NETWORK_PRESETS`. `"futurenet"` and
`"mainnet"` are the other two built-in presets. For a custom or private
network, pass a fully explicit preset instead of a name:

```ts
import { KeeperRegistryClient, type NetworkPreset } from "@soroban-keeper-network/sdk";

const localnet: NetworkPreset = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Standalone Network ; February 2017",
};

const client = new KeeperRegistryClient({
  contractId: "C...",
  network: localnet,
  keypair,
});
```

`NETWORK_NAMES` (the list of built-in preset names) and `isNetworkName()`
(a type guard for validating user-supplied network input, e.g. from an env
var or CLI flag) are also exported — see `src/network.ts` for the full
`NetworkPreset`/`NetworkName` types.

## Scope

This is a scaffold, not a full generated client: `invoke`/`read` are the
generic building blocks every specific `KeeperRegistry` call is built from,
not one hand-written method per contract function. `examples/keeper-bot`
is migrated onto this package as the first real consumer — see its
`index.js` for a complete usage example against every contract function the
bot calls.

## Development

```
npm install
npm run build   # compiles src/ to dist/
npm test        # compiles src/+test/ to dist-test/ and runs node --test
npm run lint
```

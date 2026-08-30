# @soroban-keeper-network/sdk

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

## Workspace tooling decision

This package is a **standalone npm package**, not an npm/pnpm workspace
member — there is no root `package.json` in this repository. This matches
the existing convention for `examples/keeper-bot` and
`examples/batch-register`.

## Quick start

```bash
cd packages/sdk-ts
npm install
npm run build   # emits dist/cjs (CommonJS), dist/esm (ESM), and .d.ts declarations
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

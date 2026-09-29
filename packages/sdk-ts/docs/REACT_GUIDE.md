# React hooks usage guide

`@soroban-keeper-network/sdk/react` (issues 0173–0179) gives a React app the
same typed access to the `keeper-registry` contract `KeeperRegistryClient`
provides, without each component simulating and decoding calls by hand. This
guide shows the hooks composed together, the way a real app actually uses
them; each hook's own doc comment (surfaced in the generated API reference —
see the root README's CI section) is the place for its full per-option
detail.

A runnable, worked example putting all of this together — a task list, a
register-task form, and a keeper-balance widget with a withdraw button — is
at [`examples/react-app`](../examples/react-app). This guide walks through
that example's pieces; the example itself is what to run.

## Setup: `KeeperRegistryProvider`

Every hook reads a `KeeperRegistryClient` instance from React context, so one
client is constructed once, high in the tree, and shared:

```tsx
import { KeeperRegistryClient, keypairSigner } from "@soroban-keeper-network/sdk";
import { KeeperRegistryProvider } from "@soroban-keeper-network/sdk/react";

const client = new KeeperRegistryClient({
  contractId: registryContractId,
  rpcUrl: network.rpcUrl,
  networkPassphrase: network.networkPassphrase,
  signer, // a TransactionSigner — see "Signing" below
});

function Root() {
  return (
    <KeeperRegistryProvider client={client}>
      <App />
    </KeeperRegistryProvider>
  );
}
```

Construct `client` once (e.g. with `useMemo`, as the example does) rather
than on every render — a new instance on every render would be harmless
functionally, since it's stateless, but pointless churn. Inside the
provider, any component can reach that same instance with
`useKeeperRegistryClient()` — every hook below is built on exactly that call,
so a component that needs an SDK method none of the hooks wrap yet (there is
no `useWithdrawRewards`, for instance — see below) can always fall back to it
directly.

### Signing

A hook that submits a transaction (`useRegisterTask`, and any future
`useClaimTask`/`useExecuteTask` hook once they're wired the same way) signs
through whatever `signer` the client was constructed with. In a browser app
that means a wallet extension (Freighter, or another implementing the same
`signTransaction` shape) — see
[`examples/wallet-signing/registerTaskWithFreighter.ts`](../examples/wallet-signing/registerTaskWithFreighter.ts)
for that pattern. The worked example here instead signs with a `Keypair`
loaded from a local env var, deliberately, so the guide's focus stays on
composing hooks rather than wallet integration — its `.env.example` has a
loud warning about why that pattern is dev-only and must not be copied into
anything that ships.

## Reading: `useTask`, `useTaskEvents`, `useKeeperBalance`

```tsx
import { useKeeperBalance, useTaskEvents } from "@soroban-keeper-network/sdk/react";

function TaskFeed() {
  const { events, loading, error } = useTaskEvents({ pollIntervalMs: 5000 });
  // events: TaskEvent[], newest appended, deduplicated across polls
}

function Balance({ address }: { address: string }) {
  const { balance, loading, error, refetch } = useKeeperBalance(address);
  // balance: bigint, in the reward token's own units
}
```

All three are polling-based, not push: Soroban RPC has no server-push
mechanism a browser client can use directly, so `useTask`/`useKeeperBalance`
re-simulate a view call on an interval and `useTaskEvents` re-polls
`getEvents` with its own cursor, deduplicating by the RPC's event id so a
page boundary landing mid-poll never delivers the same event twice. A
result can be up to `pollIntervalMs` stale; none of these hooks promise
lower latency than that.

## Writing: `useRegisterTask`

```tsx
import { useRegisterTask } from "@soroban-keeper-network/sdk/react";

function RegisterForm() {
  const { registerTask, status, error, reset } = useRegisterTask();

  const onSubmit = async () => {
    reset();
    const taskId = await registerTask({
      owner, taskType, calldata, reward, deadline, ttlLedgers, lockLedgers,
    });
  };

  // status: "idle" | "pending" | "success" | "error"
}
```

`status`/`error` track exactly one in-flight call; calling `registerTask`
again while `status === "pending"` starts a second concurrent submission
rather than queuing — a submit button should disable itself on `"pending"`,
as the worked example's does.

## What isn't a hook yet

Only `useTask`, `useTaskEvents`, `useRegisterTask`, and `useKeeperBalance`
exist today. In particular there is **no `useWithdrawRewards`,
`useClaimTask`, or `useExecuteTask` hook** — a component needing one of
those calls the client's plain method directly:

```tsx
import { useKeeperRegistryClient } from "@soroban-keeper-network/sdk/react";

function WithdrawButton({ keeper }: { keeper: string }) {
  const client = useKeeperRegistryClient();
  const onClick = () => client.tryWithdrawRewards({ keeper });
  // ...
}
```

This is exactly the seam every hook above is itself built on (each one is a
thin `useState`/`useCallback`/`usePolling` wrapper around one client method),
so it is not a workaround — it's the same access a hook would have, with
manual `status`/`error` state instead of what a hook would track for you.
The worked example's balance widget does exactly this for its withdraw
button.

## Running the example

```bash
cd examples/react-app
npm install
cp .env.example .env   # see its comments before changing VITE_DEMO_SECRET_KEY
npm run dev
```

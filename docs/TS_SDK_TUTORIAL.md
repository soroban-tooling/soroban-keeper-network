# Tutorial: integrate the TypeScript SDK in a dApp

You will build a small React page that registers a keeper task, signing with the
user's **Freighter wallet**, and then shows that task's live status using the
SDK's React hooks. At the end there is a short section on signing with a secret
key from a Node script or backend, which is the right choice for services but
never for a browser.

What you will use:

| Piece | From |
|---|---|
| `KeeperRegistryClient`, `TransactionSigner`, `NETWORK_PRESETS`, `TaskType` | `@soroban-keeper-network/sdk` |
| `KeeperRegistryProvider`, `useRegisterTask`, `useTask` | `@soroban-keeper-network/sdk/react` |
| `getAddress`, `requestAccess`, `signTransaction` | `@stellar/freighter-api` |

You need Node.js 20 or newer, the [Freighter](https://www.freighter.app/) browser
extension with a funded **testnet** account, and the contract id of a deployed
`keeper-registry` (see [Deploying and running](DEPLOYING.md)). The reward for
the task is escrowed from your account, so fund it with testnet XLM and make
sure it holds the registry's reward token.

> Every code sample below is a complete file. They were type-checked together
> against the current SDK (`packages/sdk-ts`, contract versions 1 to 6), with
> strict TypeScript settings, before this page was written.

## 1. Create the project

The SDK is not yet published to npm, so install it from a checkout of this
repository. Build it once so its `dist/` exists:

```bash
git clone https://github.com/soroban-tooling/soroban-keeper-network.git
(cd soroban-keeper-network/packages/sdk-ts && npm ci && npm run build)

npm create vite@latest keeper-dapp -- --template react-ts
cd keeper-dapp
npm install
npm install @stellar/stellar-sdk @stellar/freighter-api
npm install ../soroban-keeper-network/packages/sdk-ts
```

`@stellar/stellar-sdk` (v16.2 or newer) and `react` (v18) are peer dependencies
of the SDK, so your app supplies them. React is only needed if you import
`@soroban-keeper-network/sdk/react`.

Create `.env` with your registry's contract id:

```bash
VITE_NETWORK=testnet
VITE_REGISTRY_CONTRACT_ID=C...your registry contract id...
```

Nothing in `.env` is secret: it only names a network and a public contract.
Never put a secret key in a `VITE_` variable. Vite inlines those into the
bundle in plain text.

## 2. Configure the network and the read-only client

```ts
// src/config.ts
import { KeeperRegistryClient, NETWORK_PRESETS, isNetworkName } from "@soroban-keeper-network/sdk";

const networkName = import.meta.env.VITE_NETWORK ?? "testnet";
if (!isNetworkName(networkName)) {
  throw new Error(`VITE_NETWORK must be testnet, futurenet or mainnet, got ${networkName}`);
}

const contractId = import.meta.env.VITE_REGISTRY_CONTRACT_ID;
if (!contractId) {
  throw new Error("VITE_REGISTRY_CONTRACT_ID is not set");
}

export const network = NETWORK_PRESETS[networkName];

/**
 * One client for the whole app. It has no default signer: reads (such as
 * fetching a task) need none, and each write passes the connected wallet's
 * signer explicitly, so the client never outlives or mismatches the account.
 */
export const client = new KeeperRegistryClient({
  contractId,
  rpcUrl: network.rpcUrl,
  networkPassphrase: network.networkPassphrase,
});
```

`NETWORK_PRESETS` supplies the RPC URL and network passphrase for each Stellar
network. The client validates the contract id (it must be a `C...` address)
when constructed and throws a `KeeperSdkError` straight away if it is not.

## 3. Sign with a wallet

A `TransactionSigner` is the SDK's one signing seam. It is a `publicKey` plus a
`signTransaction(xdr, { networkPassphrase })` function that takes a base64
transaction envelope and returns a signed one. That is the same shape wallets
use, so Freighter adapts in a few lines:

```ts
// src/walletSigner.ts
import { getAddress, requestAccess, signTransaction } from "@stellar/freighter-api";
import type { TransactionSigner } from "@soroban-keeper-network/sdk";

/** Thrown when the user declines in the wallet. A normal outcome, not a bug. */
export class WalletRejectedError extends Error {
  constructor(reason: string) {
    super(`Wallet request was rejected or failed: ${reason}`);
    this.name = "WalletRejectedError";
  }
}

/**
 * Asks Freighter for access (prompting the user the first time) and returns
 * the connected account's address.
 */
export async function connectWallet(): Promise<string> {
  // `getAddress` answers without a prompt when this site is already allowed.
  const existing = await getAddress();
  if (!existing.error && existing.address) return existing.address;

  const granted = await requestAccess();
  if (granted.error || !granted.address) {
    throw new WalletRejectedError(granted.error?.message ?? "access was not granted");
  }
  return granted.address;
}

/** Adapts Freighter to the SDK's `TransactionSigner` for one account. */
export function freighterSigner(address: string): TransactionSigner {
  return {
    publicKey: address,
    async signTransaction(xdr, { networkPassphrase }) {
      const result = await signTransaction(xdr, { networkPassphrase, address });
      if (result.error || !result.signedTxXdr) {
        throw new WalletRejectedError(result.error?.message ?? "no signed transaction returned");
      }
      return result.signedTxXdr;
    },
  };
}
```

Two rules are worth knowing, because the SDK enforces them for you:

- The signer's `publicKey` must equal the address the contract needs to
  authorize. For `registerTask` that is the `owner`. A mismatch throws a
  `KeeperSdkError` before anything is sent, instead of failing on-chain.
- The SDK simulates the call and attaches the resource footprint **before** it
  asks the wallet to sign, so the wallet is always shown a complete,
  ready-to-submit transaction.

## 4. Provide the client

```tsx
// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KeeperRegistryProvider } from "@soroban-keeper-network/sdk/react";

import { App } from "./App";
import { client } from "./config";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <KeeperRegistryProvider client={client}>
      <App />
    </KeeperRegistryProvider>
  </StrictMode>,
);
```

Every hook reads the client from this provider. Calling a hook outside it
throws a clear error rather than failing later.

## 5. Register a task

`useRegisterTask` wraps `client.registerTask` with `status` (`idle`, `pending`,
`success`, `error`), the last `error`, and a `reset`. It returns the new
task's id as a `bigint`.

```tsx
// src/RegisterTaskForm.tsx
import { useState, type FormEvent } from "react";
import { MIN_LOCK_LEDGERS, MIN_TTL_LEDGERS, TaskType } from "@soroban-keeper-network/sdk";
import { useRegisterTask } from "@soroban-keeper-network/sdk/react";

import { freighterSigner } from "./walletSigner";

interface RegisterTaskFormProps {
  /** The connected account. It funds the reward and owns the task. */
  owner: string;
  onRegistered: (taskId: bigint) => void;
}

export function RegisterTaskForm({ owner, onRegistered }: RegisterTaskFormProps) {
  const { registerTask, status, error, reset } = useRegisterTask();
  const [reward, setReward] = useState("10000000"); // stroops: 1 token with 7 decimals

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    reset();
    try {
      const taskId = await registerTask({
        owner,
        signer: freighterSigner(owner),
        taskType: TaskType.TtlExtension,
        calldata: new Uint8Array(), // this task type needs no calldata
        reward: BigInt(reward),
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000), // a day from now
        ttlLedgers: MIN_TTL_LEDGERS,
        lockLedgers: MIN_LOCK_LEDGERS,
      });
      onRegistered(taskId);
    } catch {
      // The hook has already put the failure in `error`; nothing else to do.
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Reward (stroops){" "}
        <input value={reward} onChange={(e) => setReward(e.target.value)} inputMode="numeric" />
      </label>{" "}
      <button type="submit" disabled={status === "pending"}>
        {status === "pending" ? "Waiting for wallet and network..." : "Register task"}
      </button>
      {status === "error" && error ? <p role="alert">Failed: {error.message}</p> : null}
    </form>
  );
}
```

Points to note:

- **Wallet signing, not a secret key.** The only signer in the browser is the
  one Freighter backs; the app never sees a private key.
- `reward` is an `i128`, so pass a `bigint`. `deadline` accepts a `Date` or a
  Unix timestamp in seconds. Both must be valid or the SDK throws locally.
- `ttlLedgers` and `lockLedgers` have minimums and maximums mirrored from the
  contract (`MIN_TTL_LEDGERS`, `MIN_LOCK_LEDGERS`, `MAX_LOCK_LEDGERS`). The SDK
  checks them before spending a round trip, but the contract stays
  authoritative: it also enforces a configurable minimum reward the client
  cannot see without a read (`client.minReward()`).
- Disable the button while `status === "pending"`. Calling `registerTask`
  again starts a second, concurrent submission rather than queueing.

## 6. Show the task's status

`useTask` polls `getTask` and returns `{ task, loading, error, refetch }`. It
pauses while the browser tab is hidden and refreshes the moment the tab
becomes visible again. Its default interval is 5 seconds.

```tsx
// src/TaskStatus.tsx
import { TaskStatus as Status, TaskType, TaskNotFoundError } from "@soroban-keeper-network/sdk";
import { useTask } from "@soroban-keeper-network/sdk/react";

export function TaskStatus({ taskId }: { taskId: bigint }) {
  // The hook takes a plain number; task ids stay far below 2^53.
  const { task, loading, error } = useTask(Number(taskId), { pollIntervalMs: 5000 });

  if (error instanceof TaskNotFoundError) {
    return <p>Task #{String(taskId)} does not exist.</p>;
  }
  if (error) {
    return <p role="alert">Could not load the task: {error.message}</p>;
  }
  if (loading || !task) {
    return <p>Loading task #{String(taskId)}...</p>;
  }

  return (
    <dl>
      <dt>Task</dt>
      <dd>#{String(taskId)}</dd>
      <dt>Status</dt>
      <dd>{Status[task.status]}</dd>
      <dt>Type</dt>
      <dd>{TaskType[task.taskType]}</dd>
      <dt>Reward (stroops)</dt>
      <dd>{task.reward.toString()}</dd>
      <dt>Claimed by</dt>
      <dd>{task.claimer ?? "nobody yet"}</dd>
      <dt>Deadline</dt>
      <dd>{new Date(task.deadline * 1000).toLocaleString()}</dd>
    </dl>
  );
}
```

`error` distinguishes a task that does not exist (`TaskNotFoundError`) from a
transient RPC failure (any other `Error`), so you can show a final answer for
the first and a retry for the second. A task moves `Pending`, `Claimed`,
`Executed`, and may end as `Cancelled` or `Expired`; the page updates as keepers
act on it. Updates can lag the chain by up to one poll interval, because
Soroban RPC offers no push channel a browser can subscribe to.

## 7. Put the page together

```tsx
// src/App.tsx
import { useState } from "react";

import { RegisterTaskForm } from "./RegisterTaskForm";
import { TaskStatus } from "./TaskStatus";
import { connectWallet } from "./walletSigner";

export function App() {
  const [address, setAddress] = useState<string>();
  const [taskId, setTaskId] = useState<bigint>();
  const [connectError, setConnectError] = useState<string>();

  const handleConnect = async () => {
    setConnectError(undefined);
    try {
      setAddress(await connectWallet());
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main>
      <h1>Keeper tasks</h1>

      {address ? (
        <p>
          Connected as <code>{address}</code>
        </p>
      ) : (
        <button onClick={handleConnect}>Connect Freighter</button>
      )}
      {connectError ? <p role="alert">{connectError}</p> : null}

      {address ? <RegisterTaskForm owner={address} onRegistered={setTaskId} /> : null}
      {taskId !== undefined ? <TaskStatus taskId={taskId} /> : null}
    </main>
  );
}
```

Add one declaration so TypeScript knows Vite's `import.meta.env`; the
`react-ts` template already includes it as `src/vite-env.d.ts`
(`/// <reference types="vite/client" />`). Then run it:

```bash
npm run dev
```

Open the page, click **Connect Freighter**, approve the connection, register a
task and approve the signature in the wallet popup. The status panel appears
with the new task id, starting at `Pending`.

## 8. Handle errors

Failures reach you as typed errors, all exported from the SDK:

```ts
import { KeeperContractError, KeeperRpcError, isKeeperError } from "@soroban-keeper-network/sdk";

try {
  await client.claimTask({ keeper, taskId: 7n, signer });
} catch (err) {
  if (err instanceof KeeperContractError) {
    // The contract rejected the call (for example ContractPaused or
    // DeadlinePassed). It is deterministic: do not retry.
    console.error(err.message, "caught locally:", err.local);
  } else if (err instanceof KeeperRpcError) {
    // The network failed. Already retried per the client's maxRetries.
  } else if (isKeeperError(err)) {
    // Some other SDK error.
  } else {
    throw err;
  }
}
```

A user declining in the wallet surfaces as the `WalletRejectedError` from
section 3, thrown out of `signTransaction`. Catch it separately and show a calm
"signature cancelled" message, since declining is expected.

## Signing with a secret key (Node scripts and backends)

For a server or script that holds its own key, use `keypairSigner` and give the
client a default signer, so each call does not have to pass one:

```ts
// scripts/register-task.ts (run on a server, never ship this to a browser)
import { Keypair } from "@stellar/stellar-sdk";
import {
  KeeperRegistryClient,
  NETWORK_PRESETS,
  TaskType,
  keypairSigner,
} from "@soroban-keeper-network/sdk";

const keypair = Keypair.fromSecret(process.env.OWNER_SECRET_KEY!);
const network = NETWORK_PRESETS.testnet;

const client = new KeeperRegistryClient({
  contractId: process.env.REGISTRY_CONTRACT_ID!,
  rpcUrl: network.rpcUrl,
  networkPassphrase: network.networkPassphrase,
  signer: keypairSigner(keypair),
});

const taskId = await client.registerTask({
  owner: keypair.publicKey(),
  taskType: TaskType.TtlExtension,
  calldata: new Uint8Array(),
  reward: 10_000_000n,
  deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
  ttlLedgers: 1_000,
  lockLedgers: 12,
});

console.log(`registered task ${taskId}`);
```

Load the secret from your platform's secret store or environment, never from
source or a front-end bundle. A committed example of this pattern is
[`packages/sdk-ts/examples/node-signing`](../packages/sdk-ts/examples/node-signing).

## Where to go next

- [React hooks guide](../packages/sdk-ts/docs/REACT_GUIDE.md): the other hooks
  (`useTaskEvents`, `useKeeperBalance`) and what has no hook yet.
- [`packages/sdk-ts/examples/react-app`](../packages/sdk-ts/examples/react-app):
  a runnable app using the same hooks with a demo keypair.
- [SDK versioning](../packages/sdk-ts/VERSIONING.md) and
  [`client.checkContractCompatibility()`](../packages/sdk-ts/src/methods/views.ts)
  to confirm a deployed registry's contract version is one this SDK supports.
- [Indexer API reference](INDEXER_API.md) for task history and live events
  without polling the chain.

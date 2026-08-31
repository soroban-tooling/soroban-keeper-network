// Read-only view methods. Scoped here to just `getTask`, the one this
// epic's assigned issues (React `useTask`/`useTaskEvents` hooks) actually
// need — `taskCount`/`keeperBalance`/`isClaimable` are backlog 0163's
// remaining scope, left for that issue's own implementation.

import { nativeToScVal } from "@stellar/stellar-sdk";

import type { ContractInvoker } from "../core/contractInvoker";
import { type Task, TaskStatus, TaskType } from "../types";

/**
 * Raw shape `scValToNative` produces for the contract's `Task` struct:
 * `soroban_sdk` maps Rust struct field symbols verbatim, so this comes back
 * snake_case (confirmed against `examples/keeper-bot/index.js`'s
 * `fullTask.task_type` access — a real, working call site, not assumed) —
 * `getTask` remaps it to the camelCase {@link Task} shape the rest of this
 * SDK uses. Optional fields absent on-chain (`claimer`, `claim_ledger` for
 * a still-`Pending` task) come back `undefined` from `scValToNative`'s
 * handling of Soroban's `Option<T>`, matching this interface directly.
 */
interface RawTask {
  owner: string;
  task_type: number;
  calldata: Uint8Array;
  reward: bigint;
  deadline: bigint;
  ttl_ledgers: number;
  status: number;
  claimer: string | undefined;
  claim_ledger: number | undefined;
  lock_ledgers: number;
}

function toTask(raw: RawTask): Task {
  return {
    owner: raw.owner,
    taskType: raw.task_type as TaskType,
    calldata: raw.calldata,
    reward: raw.reward,
    // CONVENTIONS.md: `deadline` is a `number` at this SDK's boundary even
    // though the contract stores it as `u64` — a Unix-seconds timestamp is
    // nowhere near `Number.MAX_SAFE_INTEGER`, and `number` is what every
    // `Date`/polling call site in this epic (`useTask`, the wallet-signing
    // example) actually wants.
    deadline: Number(raw.deadline),
    ttlLedgers: raw.ttl_ledgers,
    status: raw.status as TaskStatus,
    claimer: raw.claimer,
    claimLedger: raw.claim_ledger,
    lockLedgers: raw.lock_ledgers,
  };
}

/**
 * Fetches one task by id. Throws (via the caller's decoded-error handling —
 * see `KeeperRegistryClient.getTask`) if the id has no on-chain record.
 *
 * Read-only view methods take a `sourcePublicKey` because Soroban simulation
 * still requires a source account to exist on-chain (see
 * `ContractInvoker.read`'s doc comment) — any funded account works, it need
 * not be a specific caller's identity.
 */
export async function getTask(
  invoker: ContractInvoker,
  taskId: number,
  readOnlySourceAccount: string | undefined,
  sourcePublicKey?: string,
): Promise<Task> {
  const source = sourcePublicKey ?? readOnlySourceAccount;
  if (!source) {
    throw new Error(
      "getTask requires a source account for simulation. Pass one explicitly " +
        "(getTask(taskId, sourcePublicKey)) or configure " +
        "KeeperRegistryClientConfig.readOnlySourceAccount — see CONVENTIONS.md.",
    );
  }
  const raw = await invoker.read<RawTask>(source, "get_task", [nativeToScVal(taskId, { type: "u64" })]);
  return toTask(raw);
}

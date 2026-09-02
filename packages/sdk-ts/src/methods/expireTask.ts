/**
 * `expire_task` -- once a task's deadline has passed without execution,
 * anyone may unwind it and return the escrowed reward to its owner.
 *
 * Mirrors `contracts/keeper-registry/src/task.rs::expire_task`.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { u64Arg } from "../core/scval.js";

export interface ExpireTaskParams extends SignedCallOptions {
  /** Id of the task to expire. */
  taskId: IntegerInput;
  /**
   * `G...` account that pays for and sources the transaction.
   *
   * Needed only to build and submit it. Alone among this SDK's mutating
   * methods, `expire_task` requires no authorization relationship between the
   * caller and the task -- the contract does not even take a caller argument,
   * so there is nothing for it to `require_auth()` against. The field is here,
   * rather than defaulted out of sight, to keep that "any account" semantics
   * visible in the signature: whoever sources the transaction is a fee payer
   * and nothing more.
   *
   * It must be the address the signer for this call signs as -- the client's
   * default signer, or a per-call {@link SignedCallOptions.signer}.
   */
  caller: string;
}

/**
 * Expires `taskId`, refunding the escrowed reward to the task's owner.
 *
 * Callable by any account, which is deliberate: it means a stuck task can
 * always be unwound and its funds recovered, even by a party with no
 * relationship to it -- a keeper bot clearing stale tasks as a courtesy while
 * it scans, say.
 *
 * Rejects with a `KeeperContractError` carrying:
 * - `DeadlineNotPassed` when the deadline is still in the future,
 * - `InvalidTaskStatus` when the task has already been executed, cancelled,
 *   or expired,
 * - `TaskNotFound` when no task has that id.
 *
 * None of these is returned as a status: unlike a claim race, there is no
 * routine outcome here a caller would want to branch on rather than handle.
 */
export async function expireTask(
  caller: ContractCaller,
  params: ExpireTaskParams,
): Promise<void> {
  const { taskId, caller: source, signer } = params;

  // Only the task id goes on the wire; `caller` is the transaction source and
  // must not leak into the invocation, or the call would not match the ABI.
  await caller.invoke<void>({
    method: "expire_task",
    source,
    args: [u64Arg(taskId, "taskId")],
    ...(signer ? { signer } : {}),
  });
}

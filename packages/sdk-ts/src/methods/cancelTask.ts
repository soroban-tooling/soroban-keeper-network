/**
 * `cancel_task` -- the owner withdraws a task and takes its escrowed reward
 * back.
 *
 * Mirrors `contracts/keeper-registry/src/task.rs::cancel_task`, which accepts
 * a task in either of two states -- this is not the older, narrower
 * "Pending only" rule:
 *
 * - `Pending` -- cancellable immediately.
 * - `Claimed` -- cancellable once the claiming keeper's lock window has
 *   lapsed, so a keeper that has started work keeps exclusive time to execute
 *   before the owner can pull the escrow out from under it.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, u64Arg } from "../core/scval.js";
import { KeeperErrorCode, isKeeperError } from "../errors.js";

export interface CancelTaskParams extends SignedCallOptions {
  /** `G...` address that registered the task. Must authorize the call. */
  owner: string;
  /** Id of the task to cancel. */
  taskId: IntegerInput;
}

/**
 * The outcome of a cancel attempt.
 *
 * `lock_period_active` and `invalid_task_status` are kept distinct because
 * they call for different follow-up, and collapsing them into one rejection
 * would hide that difference:
 *
 * - `lock_period_active` -- a `Claimed` task whose lock has not yet lapsed.
 *   The same call succeeds once it does, so this is worth retrying.
 * - `invalid_task_status` -- the task is already executed, cancelled, or
 *   expired. It can never be cancelled; retrying is pointless.
 *
 * Every other failure still rejects, including a caller who is not the task's
 * owner -- that is a bug in the caller, not a state to poll on.
 */
export type CancelTaskOutcome =
  | { status: "cancelled" }
  | { status: "lock_period_active" }
  | { status: "invalid_task_status" };

/**
 * Cancels `taskId`, refunding its escrowed reward to `owner`.
 *
 * @returns which of the three routine outcomes occurred. See
 *   {@link CancelTaskOutcome} for why two of the contract's rejections are
 *   returned here rather than thrown.
 */
export async function cancelTask(
  caller: ContractCaller,
  params: CancelTaskParams,
): Promise<CancelTaskOutcome> {
  const { owner, taskId, signer } = params;

  try {
    await caller.invoke<void>({
      method: "cancel_task",
      source: owner,
      args: [addressArg(owner, "owner"), u64Arg(taskId, "taskId")],
      ...(signer ? { signer } : {}),
    });
    return { status: "cancelled" };
  } catch (error) {
    if (isKeeperError(error, KeeperErrorCode.LockPeriodActive)) {
      return { status: "lock_period_active" };
    }
    if (isKeeperError(error, KeeperErrorCode.InvalidTaskStatus)) {
      return { status: "invalid_task_status" };
    }
    throw error;
  }
}

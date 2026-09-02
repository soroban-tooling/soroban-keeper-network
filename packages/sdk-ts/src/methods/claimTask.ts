/**
 * `claim_task` -- a keeper takes a pending task, locking out other keepers
 * for the task's `lock_ledgers` window.
 *
 * Mirrors `contracts/keeper-registry/src/task.rs::claim_task`. The call is
 * permissionless: any account may claim a `Pending` task, or a `Claimed` one
 * whose previous claimer's lock has lapsed.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, u64Arg } from "../core/scval.js";
import { KeeperErrorCode, isKeeperError } from "../errors.js";

export interface ClaimTaskParams extends SignedCallOptions {
  /** `G...` address claiming the task. Must authorize the call. */
  keeper: string;
  /** Id of the task to claim. */
  taskId: IntegerInput;
}

/**
 * The outcome of a claim attempt.
 *
 * The two rejections a keeper bot must tell apart from a hard failure come
 * back as a value rather than a throw, because for a bot scanning the board
 * they are routine rather than exceptional:
 *
 * - `lock_period_active` -- another keeper currently holds this task. Move on
 *   and come back once the lock lapses.
 * - `deadline_passed` -- the task is dead. Stop retrying it.
 *
 * Every other failure still rejects, since a paused contract, a task that does
 * not exist, or one already executed or cancelled is not part of normal claim
 * racing and should not be swallowed into a status a caller might ignore.
 */
export type ClaimTaskOutcome =
  | { status: "claimed" }
  | { status: "lock_period_active" }
  | { status: "deadline_passed" };

/**
 * Claims `taskId` for `keeper`.
 *
 * @returns which of the three routine outcomes occurred. See
 *   {@link ClaimTaskOutcome} for why losing a claim race is a return value
 *   here and not a `KeeperContractError`.
 */
export async function claimTask(
  caller: ContractCaller,
  params: ClaimTaskParams,
): Promise<ClaimTaskOutcome> {
  const { keeper, taskId, signer } = params;

  try {
    await caller.invoke<void>({
      method: "claim_task",
      source: keeper,
      args: [addressArg(keeper, "keeper"), u64Arg(taskId, "taskId")],
      ...(signer ? { signer } : {}),
    });
    return { status: "claimed" };
  } catch (error) {
    if (isKeeperError(error, KeeperErrorCode.LockPeriodActive)) {
      return { status: "lock_period_active" };
    }
    if (isKeeperError(error, KeeperErrorCode.DeadlinePassed)) {
      return { status: "deadline_passed" };
    }
    throw error;
  }
}
